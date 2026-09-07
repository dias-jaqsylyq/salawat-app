import type { ChallengeStatus } from "../api/types.ts";

export interface DaysLeftFields {
  challengeStatus: ChallengeStatus;
  challengeEndDate: string;
  daysLeft: number;
}

/** Informational Mawlid-period copy; never implies app functionality is closed. */
export function daysLeftCopy(progress: DaysLeftFields): string {
  if (progress.challengeStatus === "ended") {
    return `Mawlid period ended on ${progress.challengeEndDate}. All-time logging continues.`;
  }
  if (progress.daysLeft === 0) {
    return "Today is the last day of the Mawlid period.";
  }
  return `${progress.daysLeft} day${progress.daysLeft === 1 ? "" : "s"} left in the challenge.`;
}
