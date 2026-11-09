import { and, eq, inArray, notExists, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  coupons,
  lessonProgress,
  lessons,
  modules,
  purchases,
  refunds,
  videoWatchEvents,
  LessonProgressStatus,
} from "~/db/schema";

export const REFUND_WINDOW_DAYS = 14;
const REFUND_WATCH_LIMIT_SECONDS = 2 * 60 * 60;
const REFUND_COMPLETION_LIMIT = 0.5;

type Purchase = typeof purchases.$inferSelect;

export type RefundEligibility =
  | {
      refundable: true;
      purchase: Purchase;
      /** Always the amount the learner paid. */
      amount: number;
      lastDayInWindow: string;
    }
  | { refundable: false; reason: string; status: 403 | 409 };

// A team purchase buys seats for other people and always has coupons; a
// personal purchase is the one that gave the learner access and has none.
// After an approved Refund a learner may buy again, so take the latest.
function getPersonalPurchase(userId: number, courseId: number) {
  return db
    .select()
    .from(purchases)
    .where(
      and(
        eq(purchases.userId, userId),
        eq(purchases.courseId, courseId),
        notExists(
          db
            .select({ id: coupons.id })
            .from(coupons)
            .where(eq(coupons.purchaseId, purchases.id))
        )
      )
    )
    .orderBy(sql`${purchases.createdAt} desc`)
    .get();
}

function hasHadRefund(purchaseId: number) {
  return Boolean(
    db
      .select({ id: refunds.id })
      .from(refunds)
      .where(eq(refunds.purchaseId, purchaseId))
      .get()
  );
}

function getCourseLessonIds(courseId: number) {
  return db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);
}

function getCompletedLessonCount(userId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;

  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .get();

  return result?.count ?? 0;
}

function getSecondsWatched(userId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;

  const furthestPerLesson = db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all();

  return furthestPerLesson.reduce((total, row) => total + row.furthest, 0);
}

// The Refund Window is counted in whole days, not hours — someone who buys at
// 23:00 should still get the whole of their fourteenth day.
function asDayString(when: Date) {
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${when.getFullYear()}-${month}-${day}`;
}

/**
 * Whether the learner's personal purchase of a course is Refundable — see
 * GLOSSARY.md. The course page uses this to offer a Refund and the refund
 * route uses it to accept one, so the two can never disagree.
 */
export function checkRefundable(
  userId: number,
  courseId: number,
  now: Date = new Date()
): RefundEligibility {
  const purchase = getPersonalPurchase(userId, courseId);

  if (!purchase) {
    return {
      refundable: false,
      reason: "You have not bought this course.",
      status: 403,
    };
  }

  if (hasHadRefund(purchase.id)) {
    return {
      refundable: false,
      reason: "This purchase has already had a Refund.",
      status: 409,
    };
  }

  const purchasedAt = new Date(purchase.createdAt);
  const windowEnd = new Date(purchasedAt);
  windowEnd.setDate(windowEnd.getDate() + REFUND_WINDOW_DAYS);
  const lastDayInWindow = asDayString(windowEnd);
  const today = asDayString(now);

  if (today < asDayString(purchasedAt) || today > lastDayInWindow) {
    return {
      refundable: false,
      reason: `The ${REFUND_WINDOW_DAYS}-day Refund Window has closed.`,
      status: 403,
    };
  }

  const lessonIds = getCourseLessonIds(courseId);

  if (
    lessonIds.length > 0 &&
    getCompletedLessonCount(userId, lessonIds) / lessonIds.length >=
      REFUND_COMPLETION_LIMIT
  ) {
    return {
      refundable: false,
      reason: "You have completed too much of this course to get a Refund.",
      status: 403,
    };
  }

  if (getSecondsWatched(userId, lessonIds) >= REFUND_WATCH_LIMIT_SECONDS) {
    return {
      refundable: false,
      reason: "You have watched too much of this course to get a Refund.",
      status: 403,
    };
  }

  return {
    refundable: true,
    purchase,
    amount: purchase.amountPaid,
    lastDayInWindow,
  };
}
