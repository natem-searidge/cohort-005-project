import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { checkRefundable } from "./refunds.server";

let testDb: ReturnType<typeof createTestDb>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

const NOW = new Date(2026, 10, 9, 12, 0, 0);

function daysBefore(days: number) {
  const when = new Date(NOW);
  when.setDate(when.getDate() - days);
  return when.toISOString();
}

let base: ReturnType<typeof seedBaseData>;
let lessonIds: number[];

beforeEach(() => {
  testDb = createTestDb();
  base = seedBaseData(testDb);

  testDb
    .update(schema.courses)
    .set({ price: 7900 })
    .run();

  const mod = testDb
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Module", position: 1 })
    .returning()
    .get();

  lessonIds = [1, 2, 3, 4].map(
    (position) =>
      testDb
        .insert(schema.lessons)
        .values({ moduleId: mod.id, title: `Lesson ${position}`, position })
        .returning()
        .get().id
  );
});

function buy(input: { amountPaid?: number; daysAgo?: number } = {}) {
  return testDb
    .insert(schema.purchases)
    .values({
      userId: base.user.id,
      courseId: base.course.id,
      amountPaid: input.amountPaid ?? 4900,
      country: "US",
      createdAt: daysBefore(input.daysAgo ?? 1),
    })
    .returning()
    .get();
}

function buyTeamSeats(input: {
  amountPaid: number;
  daysAgo: number;
  claimed: boolean;
}) {
  const purchase = buy(input);
  const team = testDb.insert(schema.teams).values({}).returning().get();
  testDb
    .insert(schema.coupons)
    .values({
      teamId: team.id,
      courseId: base.course.id,
      code: `SEAT-${purchase.id}`,
      purchaseId: purchase.id,
      redeemedByUserId: input.claimed ? base.user.id : null,
      redeemedAt: input.claimed ? NOW.toISOString() : null,
    })
    .run();
  return purchase;
}

function complete(count: number) {
  for (const lessonId of lessonIds.slice(0, count)) {
    testDb
      .insert(schema.lessonProgress)
      .values({
        userId: base.user.id,
        lessonId,
        status: schema.LessonProgressStatus.Completed,
      })
      .run();
  }
}

function watch(lessonId: number, positionSeconds: number) {
  testDb
    .insert(schema.videoWatchEvents)
    .values({
      userId: base.user.id,
      lessonId,
      eventType: "progress",
      positionSeconds,
    })
    .run();
}

function check() {
  return checkRefundable(base.user.id, base.course.id, NOW);
}

describe("checkRefundable", () => {
  it("is refundable for a fresh purchase", () => {
    buy();
    expect(check()).toMatchObject({ refundable: true });
  });

  it("refunds the amount paid, not the current list price", () => {
    buy({ amountPaid: 4900 });
    expect(check()).toMatchObject({ refundable: true, amount: 4900 });
  });

  it("is not refundable without a purchase", () => {
    expect(check()).toMatchObject({ refundable: false, status: 403 });
  });

  it("is refundable on the last day of the Refund Window", () => {
    buy({ daysAgo: 14 });
    expect(check()).toMatchObject({ refundable: true });
  });

  it("is not refundable after the Refund Window closes", () => {
    buy({ daysAgo: 15 });
    expect(check()).toMatchObject({ refundable: false, status: 403 });
  });

  it("is not refundable once half the lessons are completed", () => {
    buy();
    complete(2);
    expect(check()).toMatchObject({ refundable: false, status: 403 });
  });

  it("is refundable with less than half the lessons completed", () => {
    buy();
    complete(1);
    expect(check()).toMatchObject({ refundable: true });
  });

  it("is not refundable once two hours of video are watched", () => {
    buy();
    watch(lessonIds[0], 3600);
    watch(lessonIds[1], 3600);
    expect(check()).toMatchObject({ refundable: false, status: 403 });
  });

  it("refunds the personal purchase when a team purchase came later", () => {
    const personal = buy({ amountPaid: 4900, daysAgo: 3 });
    buyTeamSeats({ amountPaid: 5 * 4900, daysAgo: 1, claimed: true });
    expect(check()).toMatchObject({
      refundable: true,
      amount: 4900,
      purchase: { id: personal.id },
    });
  });

  it("is not refundable when the only purchase is a team purchase", () => {
    buyTeamSeats({ amountPaid: 5 * 4900, daysAgo: 1, claimed: false });
    expect(check()).toMatchObject({ refundable: false, status: 403 });
  });

  it.each([
    schema.RefundStatus.Requested,
    schema.RefundStatus.Approved,
    schema.RefundStatus.Declined,
  ])("is not refundable after a %s Refund", (status) => {
    const purchase = buy();
    testDb
      .insert(schema.refunds)
      .values({ purchaseId: purchase.id, status, reason: "Not for me" })
      .run();
    expect(check()).toMatchObject({ refundable: false, status: 409 });
  });
});
