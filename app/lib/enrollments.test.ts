import { describe, expect, it } from "vitest";
import { isUnenrolled } from "./enrollments";

describe("isUnenrolled", () => {
  it("is false while the Student still has an Enrollment on the course", () => {
    expect(isUnenrolled({ enrollmentId: 12 })).toBe(false);
  });

  it("is true once the Student's Enrollment has ended", () => {
    expect(isUnenrolled({ enrollmentId: null })).toBe(true);
  });
});
