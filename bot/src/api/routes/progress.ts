import type { Request, Response } from "express";
import { config } from "../../config.js";
import { getUserByTelegramId } from "../../db/repository.js";
import { formatDateParts, getChallengeStatus } from "../../utils/challenge.js";
import { userNeedsRealName } from "../realName.js";
import { computeUserProgressFields } from "./progressFields.js";

function challengeMeta() {
  return {
    challengeStatus: getChallengeStatus(),
    challengeStartDate: formatDateParts(config.challengeStartDate),
    challengeEndDate: formatDateParts(config.challengeEndDate),
  };
}

export function progressRoute(req: Request, res: Response) {
  const user = getUserByTelegramId(req.telegramId);
  if (!user) {
    res.json({ registered: false, ...challengeMeta() });
    return;
  }

  const fields = computeUserProgressFields(user);

  res.json({
    registered: true,
    nickname: user.nickname,
    total: fields.total,
    todayTotal: fields.todayTotal,
    dailyGoal: fields.dailyGoal,
    streak: fields.streak,
    last7Days: fields.last7Days,
    daysLeft: fields.daysLeft,
    needsRealName: userNeedsRealName(user.real_name),
    ...challengeMeta(),
  });
}
