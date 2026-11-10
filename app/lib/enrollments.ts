/** A Student on the roster who no longer has an Enrollment on the course. */
export function isUnenrolled(student: { enrollmentId: number | null }): boolean {
  return student.enrollmentId === null;
}
