import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { DATA_DIR } from "./config.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { writeFileAtomic } from "./atomic.ts";
import { redactSecretsInText } from "./redact.ts";
import type { GroupGoalRunStatus } from "../shared/group-goal-run.ts";
import type { RoutineRequestOperation } from "../shared/routine-request.ts";

export type RoutineSchedule =
  | { type: "once"; at: number }
  | { type: "daily"; time: string; weekdays: number[] }
  | {
      type: "interval";
      everyMinutes: number;
      anchorAt: number;
      activeHours?: { start: string; end: string };
    };

/** `cloud` runs the agent itself inside the bot's Box VM. `maus` keeps
 * using the provider selected on the MAUS and only borrows its configured
 * computer tools, if any. */
export type RoutineRunOn = "maus" | "cloud";
export type RoutineTarget = "bot" | "room-goal";
export type RoutineGoalStatus = Exclude<GroupGoalRunStatus, "working">;

export interface RoutineContextAttachment {
  id: string;
  kind: "file" | "image";
  name: string;
  path: string;
  size: number;
}

const persistedSourceThreadId = z.string().trim().min(1).optional().catch(undefined);

export type RoutineRunTrigger = "schedule" | "manual" | "webhook";

export type RoutineRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "missed";

export interface Routine {
  id: string;
  name: string;
  prompt: string;
  target: RoutineTarget;
  /** A bot routine's owner, or the lead coordinator for a room goal. */
  botId: string;
  groupId?: string;
  runOn: RoutineRunOn;
  enabled: boolean;
  schedule: RoutineSchedule;
  /** Legacy calendar/display length. Kept for persisted-data compatibility. */
  durationMinutes: number;
  /** Optional safety cap for active work. Missing means no timeout. */
  timeoutMinutes?: number;
  attachments?: RoutineContextAttachment[];
  /** Conversation that created this routine in chat. Calendar/import-created
   * routines intentionally have no source, and older files migrate in place. */
  sourceThreadId?: string;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface RoutineRun {
  id: string;
  routineId: string;
  routineName: string;
  /** Snapshot the work so an edited/deleted definition cannot rewrite history. */
  prompt?: string;
  /** Snapshot of the legacy calendar/display length. */
  durationMinutes?: number;
  /** Snapshot of the optional active-work safety cap. */
  timeoutMinutes?: number;
  attachments?: RoutineContextAttachment[];
  target: RoutineTarget;
  /** Exact terminal room outcome. `status` remains the scheduler lifecycle
   * while this preserves blocked/needs-input/limit semantics and closes the
   * cross-file crash-recovery gap with the room's goal card. */
  goalStatus?: RoutineGoalStatus;
  /** Snapshot the room as well as the coordinator so edited definitions do
   * not redirect already-queued team work. */
  groupId?: string;
  botId: string;
  runOn: RoutineRunOn;
  scheduledFor: number;
  status: RoutineRunStatus;
  manual: boolean;
  /** Why this receipt exists. Kept optional so version-1 files migrate in place. */
  triggerSource?: RoutineRunTrigger;
  webhookId?: string;
  deliveryId?: string;
  /** Snapshot the routine's reporting destination. Execution remains on the
   * separate `threadId` so recurring work never contaminates chat context. */
  sourceThreadId?: string;
  threadId?: string;
  startedAt?: number;
  finishedAt?: number;
  output?: string;
  /** Human-readable reason the detached execution is waiting. */
  attention?: string;
  error?: string;
  cost?: number | null;
  denials?: string[];
  createdAt: number;
  seenAt?: number;
}

export interface RoutineRequestReceipt {
  requestId: string;
  messageId: string;
  botId: string;
  threadId: string;
  action: RoutineRequestOperation["action"];
  fingerprintVersion: 1;
  /** SHA-256 of the strict normalized operation carried by the card. */
  fingerprint: string;
  resultId: string;
  appliedAt: number;
}

export interface RoutineRequestCommit {
  requestId: string;
  messageId: string;
  botId: string;
  threadId: string;
  action: RoutineRequestOperation["action"];
  fingerprintVersion: 1;
  fingerprint: string;
}

export interface RoutineCheckpoint {
  routineId: string;
  source: string;
  watermark?: string;
  sourceKeys: string[];
  updatedAt: number;
}

type RoutineRequestCommitFor<Action extends RoutineRequestOperation["action"]> =
  Omit<RoutineRequestCommit, "action"> & { action: Action };

export interface RoutineInput {
  name: string;
  prompt: string;
  target?: RoutineTarget;
  botId: string;
  /** `null` deliberately clears a room when changing the target back to a bot. */
  groupId?: string | null;
  runOn?: RoutineRunOn;
  enabled?: boolean;
  schedule: RoutineSchedule;
  durationMinutes?: number;
  /** `null` deliberately removes an existing safety cap. */
  timeoutMinutes?: number | null;
  attachments?: RoutineContextAttachment[];
}

interface RoutineFile {
  version: 1;
  routines: Routine[];
  runs: RoutineRun[];
  /** Durable commit receipts for cross-file confirmation recovery. */
  routineRequestReceipts?: RoutineRequestReceipt[];
  /** Per-source reconciliation cursors and completed source keys. Kept in the
   * existing routine file so restarts cannot replay already-applied work. */
  checkpoints?: RoutineCheckpoint[];
}

export type RoutineRequestOwner = Pick<RoutineRequestReceipt, "requestId" | "messageId" | "botId" | "threadId">;

function routineRequestOwnerKey(owner: RoutineRequestOwner): string {
  return JSON.stringify([owner.requestId, owner.messageId, owner.botId, owner.threadId]);
}

export interface RoutineManagerOptions {
  file?: string;
  now?: () => number;
  /** Keyed frames only: every payload on this bus is `{ kind, … }`, which
   * is what lets the server number and replay them. */
  emit?: (payload: Record<string, unknown>) => void;
  botState: (botId: string) => "ready" | "busy" | "missing";
  goalState?: (groupId: string, coordinatorBotId: string) => "ready" | "busy" | "missing";
  createTask: (botId: string, title: string, activate?: boolean) => { threadId: string } | null;
  createGoalTask?: (groupId: string, title: string) => { threadId: string } | null;
  startTurn: (
    botId: string,
    threadId: string,
    prompt: string,
    runOn: RoutineRunOn,
    triggerSource: RoutineRunTrigger,
    authorityId: string,
    onDispatchError: (message: string) => void,
  ) => Promise<void>;
  startGoal?: (
    groupId: string,
    threadId: string,
    prompt: string,
    coordinatorBotId: string,
    runId: string,
    authorityId: string,
    timeoutMinutes: number | undefined,
    onDispatchError: (message: string) => void,
  ) => Promise<void>;
  interruptTurn?: (botId: string, threadId: string, runOn: RoutineRunOn) => Promise<void>;
  interruptGoal?: (
    groupId: string,
    threadId: string,
    outcome?: { status: "stopped" | "limit-reached"; detail: string },
  ) => Promise<void>;
  /** Projects every durable transition into the source conversation. */
  onRunChanged?: (run: RoutineRun) => void;
  onRunFailed?: (run: RoutineRun) => void;
}

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const CATCH_UP_MS = 12 * 60 * 60_000;
const MAX_DATE_MS = 8_640_000_000_000_000;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_RUNS = 2_000;
const MAX_ATTACHMENTS = 50;
const MAX_CHECKPOINT_SOURCE_KEYS = 5_000;
const checkpointText = z.string().trim().min(1).max(2_000);
const attachmentSchema = z.object({
  id: z.string().trim().min(1).max(200),
  kind: z.enum(["file", "image"]),
  name: z.string().trim().min(1).max(255),
  path: z.string().trim().min(1).max(4_096),
  size: z.number().finite().nonnegative(),
});
const ROUTINE_REQUEST_ACTIONS = new Set<RoutineRequestOperation["action"]>([
  "create",
  "update",
  "pause",
  "resume",
  "run_now",
  "delete",
]);

function isRoutineRequestAction(value: unknown): value is RoutineRequestOperation["action"] {
  return typeof value === "string" && ROUTINE_REQUEST_ACTIONS.has(value as RoutineRequestOperation["action"]);
}

function cleanDays(days: unknown): number[] {
  if (!Array.isArray(days)) return ALL_DAYS;
  const out = [...new Set(days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  return out.length ? out : ALL_DAYS;
}

function cleanAttachments(value: unknown): RoutineContextAttachment[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) {
    throw new Error(`Add no more than ${MAX_ATTACHMENTS} attachments`);
  }
  const ids = new Set<string>();
  return value.map((candidate) => {
    const parsed = attachmentSchema.safeParse(candidate);
    if (!parsed.success || parsed.data.name.includes("\0") || parsed.data.path.includes("\0")) {
      throw new Error("Choose a valid attachment");
    }
    if (ids.has(parsed.data.id)) throw new Error("Each attachment must be unique");
    ids.add(parsed.data.id);
    return { ...parsed.data };
  });
}

function cleanTimeoutMinutes(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 5 || value > 240) {
    throw new Error("Run limit must be a whole number from 5 to 240 minutes");
  }
  return value;
}

function loadTimeoutMinutes(value: unknown): number | undefined {
  try {
    return cleanTimeoutMinutes(value);
  } catch {
    return undefined;
  }
}

/** A malformed legacy metadata field must not make the scheduler forget the
 * otherwise valid routine or run that owns it. New writes still fail closed. */
function loadAttachments(value: unknown): RoutineContextAttachment[] {
  try {
    return cleanAttachments(value);
  } catch {
    return [];
  }
}

function cloneSchedule(schedule: RoutineSchedule): RoutineSchedule {
  if (schedule.type === "once") return { type: "once", at: schedule.at };
  if (schedule.type === "interval") {
    return {
      type: "interval",
      everyMinutes: schedule.everyMinutes,
      anchorAt: schedule.anchorAt,
      ...(schedule.activeHours
        ? { activeHours: { ...schedule.activeHours } }
        : {}),
    };
  }
  return { type: "daily", time: schedule.time, weekdays: [...schedule.weekdays] };
}

function cloneAttachments(attachments: readonly RoutineContextAttachment[] | undefined): RoutineContextAttachment[] {
  return attachments?.map((attachment) => ({ ...attachment })) ?? [];
}

function loadTarget(value: unknown): RoutineTarget {
  return value === "room-goal" ? "room-goal" : "bot";
}

const ROUTINE_GOAL_STATUSES = new Set<RoutineGoalStatus>([
  "completed",
  "needs-input",
  "blocked",
  "limit-reached",
  "paused",
  "stopped",
  "failed",
]);

function loadGoalStatus(value: unknown, target: RoutineTarget): RoutineGoalStatus | undefined {
  return target === "room-goal" && typeof value === "string" && ROUTINE_GOAL_STATUSES.has(value as RoutineGoalStatus)
    ? value as RoutineGoalStatus
    : undefined;
}

function loadGroupId(value: unknown, target: RoutineTarget): string | undefined {
  if (target !== "room-goal" || typeof value !== "string") return undefined;
  return value.trim() || undefined;
}

function cloneRoutine(routine: Routine): Routine {
  return {
    ...routine,
    schedule: cloneSchedule(routine.schedule),
    attachments: cloneAttachments(routine.attachments),
  };
}

function cloneRun(run: RoutineRun): RoutineRun {
  return {
    ...run,
    attachments: cloneAttachments(run.attachments),
    denials: run.denials ? [...run.denials] : undefined,
  };
}

function cloneCheckpoint(checkpoint: RoutineCheckpoint): RoutineCheckpoint {
  return { ...checkpoint, sourceKeys: [...checkpoint.sourceKeys] };
}

/** Keep untrusted local paths inside the same quoted tag shape used by chat. */
function escapeAttachmentPath(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\t", "&#9;")
    .replaceAll("\r", "&#13;")
    .replaceAll("\n", "&#10;");
}

function composeExecutionPrompt(prompt: string, attachments: readonly RoutineContextAttachment[] | undefined): string {
  const parts = [prompt];
  for (const attachment of attachments ?? []) {
    const tag = attachment.kind === "image" ? "attached-image" : "attached-file";
    parts.push(`<${tag} path="${escapeAttachmentPath(attachment.path)}" />`);
  }
  return parts.filter(Boolean).join("\n\n");
}

function minutesOfDay(time: string): number {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

function withinActiveHours(
  activeHours: NonNullable<Extract<RoutineSchedule, { type: "interval" }>["activeHours"]>,
  at: number,
): boolean {
  const date = new Date(at);
  const minute = date.getHours() * 60 + date.getMinutes();
  const start = minutesOfDay(activeHours.start);
  const end = minutesOfDay(activeHours.end);
  return start < end
    ? minute >= start && minute < end
    : minute >= start || minute < end;
}

function intervalTickBound(everyMinutes: number): number {
  return Math.ceil((2 * 1_440) / everyMinutes) + 2;
}

function cleanActiveHours(
  activeHours: unknown,
  everyMinutes: number,
): Extract<RoutineSchedule, { type: "interval" }>["activeHours"] {
  if (activeHours === undefined) return undefined;
  if (
    !activeHours ||
    typeof activeHours !== "object" ||
    !("start" in activeHours) ||
    !("end" in activeHours) ||
    typeof activeHours.start !== "string" ||
    typeof activeHours.end !== "string" ||
    !TIME.test(activeHours.start) ||
    !TIME.test(activeHours.end)
  ) {
    throw new Error("Active hours must use HH:MM");
  }
  const start = minutesOfDay(activeHours.start);
  const end = minutesOfDay(activeHours.end);
  const span = (end - start + 1_440) % 1_440;
  if (activeHours.start === activeHours.end || span < everyMinutes) {
    throw new Error("Active hours must span at least one interval");
  }
  return { start: activeHours.start, end: activeHours.end };
}

function cleanSchedule(schedule: RoutineSchedule): RoutineSchedule {
  if (schedule?.type === "once") {
    const at = Number(schedule.at);
    if (!Number.isFinite(at)) throw new Error("Choose a valid date and time");
    return { type: "once", at };
  }
  if (schedule?.type === "daily") {
    const time = String(schedule.time ?? "");
    if (!TIME.test(time)) throw new Error("Time must use HH:MM");
    return { type: "daily", time, weekdays: cleanDays(schedule.weekdays) };
  }
  if (schedule?.type === "interval") {
    const { everyMinutes, anchorAt } = schedule;
    if (typeof everyMinutes !== "number" || !Number.isInteger(everyMinutes) || everyMinutes < 5 || everyMinutes > 1_440) {
      throw new Error("Interval must be a whole number from 5 to 1440 minutes");
    }
    if (
      typeof anchorAt !== "number" ||
      !Number.isSafeInteger(anchorAt) ||
      anchorAt < 0 ||
      anchorAt > MAX_DATE_MS
    ) {
      throw new Error("Choose a valid interval start time");
    }
    const activeHours = cleanActiveHours(schedule.activeHours, everyMinutes);
    return {
      type: "interval",
      everyMinutes,
      anchorAt,
      ...(activeHours ? { activeHours } : {}),
    };
  }
  throw new Error("Choose a supported schedule");
}

function loadSchedule(value: unknown): RoutineSchedule | null {
  try {
    return cleanSchedule(value as RoutineSchedule);
  } catch {
    return null;
  }
}

/** Next wall-clock occurrence in this computer's timezone, strictly after `after`. */
export function nextOccurrence(schedule: RoutineSchedule, after: number): number | null {
  if (schedule.type === "once") return schedule.at > after ? schedule.at : null;
  if (schedule.type === "interval") {
    const intervalMs = schedule.everyMinutes * 60_000;
    let candidate = schedule.anchorAt > after
      ? schedule.anchorAt
      : schedule.anchorAt + (Math.floor((after - schedule.anchorAt) / intervalMs) + 1) * intervalMs;
    if (!Number.isSafeInteger(candidate) || candidate > MAX_DATE_MS) return null;
    if (!schedule.activeHours) return candidate;
    for (let step = 0; step < intervalTickBound(schedule.everyMinutes); step++) {
      if (withinActiveHours(schedule.activeHours, candidate)) return candidate;
      candidate += intervalMs;
      if (!Number.isSafeInteger(candidate) || candidate > MAX_DATE_MS) return null;
    }
    return null;
  }
  const [hour, minute] = schedule.time.split(":").map(Number);
  const weekdays = new Set(cleanDays(schedule.weekdays));
  for (let offset = 0; offset <= 8; offset++) {
    const d = new Date(after);
    d.setDate(d.getDate() + offset);
    d.setHours(hour, minute, 0, 0);
    if (d.getTime() > after && weekdays.has(d.getDay())) return d.getTime();
  }
  return null;
}

function latestIntervalOccurrence(
  schedule: Extract<RoutineSchedule, { type: "interval" }>,
  at: number,
): number | null {
  if (schedule.anchorAt > at) return null;
  const intervalMs = schedule.everyMinutes * 60_000;
  let candidate = schedule.anchorAt + Math.floor((at - schedule.anchorAt) / intervalMs) * intervalMs;
  if (!schedule.activeHours) return candidate;
  for (let step = 0; step < intervalTickBound(schedule.everyMinutes) && candidate >= schedule.anchorAt; step++) {
    if (withinActiveHours(schedule.activeHours, candidate)) return candidate;
    candidate -= intervalMs;
  }
  return null;
}

function sanitizeInput(input: RoutineInput): Omit<Routine, "id" | "createdAt" | "updatedAt" | "nextRunAt"> {
  const name = String(input.name ?? "").trim().slice(0, 80);
  const prompt = String(input.prompt ?? "").trim().slice(0, 20_000);
  const botId = String(input.botId ?? "").trim();
  if (!name) throw new Error("Give the routine a name");
  if (!prompt) throw new Error("Tell the bot what to do");
  if (!botId) throw new Error("Choose a bot");
  const target = input.target ?? "bot";
  if (target !== "bot" && target !== "room-goal") throw new Error("Choose a valid routine target");
  const groupId = typeof input.groupId === "string" ? input.groupId.trim() : "";
  if (target === "room-goal" && !groupId) throw new Error("Choose a room for this goal");
  const runOn = input.runOn ?? "maus";
  if (runOn !== "maus" && runOn !== "cloud") throw new Error("Choose where this routine runs");
  const attachments = cleanAttachments(input.attachments);
  const timeoutMinutes = cleanTimeoutMinutes(input.timeoutMinutes);
  if (target === "room-goal" && runOn === "cloud") {
    throw new Error("Room goals can only run on this computer");
  }
  if (target === "room-goal" && attachments.length > 0) {
    throw new Error("Room goals do not support attachments yet");
  }
  if (runOn === "cloud" && attachments.length > 0) {
    throw new Error("Attachments can only run on this computer until cloud file staging is available");
  }
  return {
    name,
    prompt,
    target,
    botId,
    groupId: target === "room-goal" ? groupId : undefined,
    runOn,
    enabled: input.enabled !== false,
    schedule: cleanSchedule(input.schedule),
    durationMinutes: Math.min(240, Math.max(5, Math.round(Number(input.durationMinutes) || 30))),
    ...(timeoutMinutes === undefined ? {} : { timeoutMinutes }),
    attachments,
  };
}

export class RoutineManager {
  private readonly file: string;
  private readonly now: () => number;
  private readonly options: RoutineManagerOptions;
  private routines: Routine[] = [];
  private runs: RoutineRun[] = [];
  private routineRequestReceipts: RoutineRequestReceipt[] = [];
  private checkpoints: RoutineCheckpoint[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(options: RoutineManagerOptions) {
    this.options = options;
    this.file = options.file ?? join(DATA_DIR, "routines.json");
    this.now = options.now ?? Date.now;
    try {
      const disk = JSON.parse(readFileSync(this.file, "utf8")) as Partial<RoutineFile>;
      this.routines = Array.isArray(disk.routines)
        ? disk.routines.flatMap((routine) => {
            const schedule = loadSchedule(routine.schedule);
            if (!schedule) return [];
            const target = loadTarget(routine.target);
            const loaded: Routine = {
              ...routine,
              schedule,
              target,
              groupId: loadGroupId(routine.groupId, target),
              runOn: routine.runOn ?? "maus",
              timeoutMinutes: loadTimeoutMinutes(routine.timeoutMinutes),
              attachments: loadAttachments(routine.attachments),
              sourceThreadId: persistedSourceThreadId.parse(routine.sourceThreadId),
            };
            if (loaded.timeoutMinutes === undefined) delete loaded.timeoutMinutes;
            return [loaded];
          })
        : [];
      this.runs = Array.isArray(disk.runs)
        ? disk.runs.map((run) => {
            const target = loadTarget(run.target);
            const loaded: RoutineRun = {
              ...run,
              target,
              goalStatus: loadGoalStatus(run.goalStatus, target),
              groupId: loadGroupId(run.groupId, target),
              runOn: run.runOn ?? "maus",
              timeoutMinutes: loadTimeoutMinutes(run.timeoutMinutes),
              attachments: loadAttachments(run.attachments),
              sourceThreadId: persistedSourceThreadId.parse(run.sourceThreadId),
            };
            if (loaded.timeoutMinutes === undefined) delete loaded.timeoutMinutes;
            return loaded;
          })
        : [];
      this.routineRequestReceipts = Array.isArray(disk.routineRequestReceipts)
        ? disk.routineRequestReceipts.filter((receipt): receipt is RoutineRequestReceipt =>
            typeof receipt?.requestId === "string" &&
            typeof receipt?.messageId === "string" &&
            typeof receipt?.botId === "string" &&
            typeof receipt?.threadId === "string" &&
            isRoutineRequestAction(receipt?.action) &&
            receipt?.fingerprintVersion === 1 &&
            typeof receipt?.fingerprint === "string" && /^[a-f0-9]{64}$/.test(receipt.fingerprint) &&
            typeof receipt?.resultId === "string" &&
            Number.isFinite(receipt?.appliedAt)
          )
        : [];
      this.checkpoints = Array.isArray(disk.checkpoints)
        ? disk.checkpoints.flatMap((checkpoint) => {
            const routineId = typeof checkpoint?.routineId === "string" ? checkpoint.routineId.trim() : "";
            const source = typeof checkpoint?.source === "string" ? checkpoint.source.trim() : "";
            if (!routineId || !source || !Array.isArray(checkpoint?.sourceKeys)) return [];
            return [{
              routineId,
              source,
              ...(typeof checkpoint.watermark === "string" && checkpoint.watermark ? { watermark: checkpoint.watermark.slice(0, 2_000) } : {}),
              sourceKeys: checkpoint.sourceKeys
                .filter((key): key is string => typeof key === "string" && key.length > 0)
                .slice(-MAX_CHECKPOINT_SOURCE_KEYS),
              updatedAt: Number.isSafeInteger(checkpoint.updatedAt) ? checkpoint.updatedAt : 0,
            }];
          })
        : [];
    } catch {
      this.routines = [];
      this.runs = [];
      this.routineRequestReceipts = [];
    }
    // A local process cannot still own these turns after a full restart.
    const recovered: RoutineRun[] = [];
    for (const run of this.runs) {
      if (run.status === "running" || run.status === "waiting") {
        run.status = "failed";
        if (run.target === "room-goal") run.goalStatus = "failed";
        run.error = "OpenMausBot restarted while this routine was running";
        run.attention = undefined;
        run.finishedAt = this.now();
        recovered.push(cloneRun(run));
      }
    }
    if (recovered.length > 0) {
      this.save();
      for (const run of recovered) {
        this.notifyRunChanged(run);
        this.options.onRunFailed?.(run);
      }
    }
  }

  listRoutines(): Routine[] {
    return this.routines.map(cloneRoutine);
  }

  listRuns(from?: number, to?: number): RoutineRun[] {
    return this.runs
      .filter((r) => (from == null || r.scheduledFor >= from) && (to == null || r.scheduledFor <= to))
      .sort((a, b) => b.scheduledFor - a.scheduledFor)
      .map(cloneRun);
  }

  activeRunForBot(botId: string): RoutineRun | null {
    const run = this.runs.find(
      (candidate) => candidate.botId === botId && ["running", "waiting"].includes(candidate.status),
    );
    return run ? cloneRun(run) : null;
  }

  /** Active work that owns the bot's direct conversation. Room goals may use
   * the same bot as their coordinator, but execute in a separate room task. */
  activeBotRunForBot(botId: string): RoutineRun | null {
    const run = this.runs.find(
      (candidate) => candidate.target === "bot" &&
        candidate.botId === botId &&
        ["running", "waiting"].includes(candidate.status),
    );
    return run ? cloneRun(run) : null;
  }

  checkpointForRun(threadId: string, botId: string, rawSource: unknown): RoutineCheckpoint {
    const run = this.checkpointRun(threadId, botId);
    const source = checkpointText.parse(rawSource);
    const checkpoint = this.checkpoints.find((candidate) => candidate.routineId === run.routineId && candidate.source === source);
    return checkpoint
      ? cloneCheckpoint(checkpoint)
      : { routineId: run.routineId, source, sourceKeys: [], updatedAt: 0 };
  }

  commitCheckpointForRun(
    threadId: string,
    botId: string,
    input: { source: unknown; sourceKey: unknown; watermark?: unknown },
  ): { duplicate: boolean; checkpoint: RoutineCheckpoint } {
    const run = this.checkpointRun(threadId, botId);
    const source = checkpointText.parse(input.source);
    const sourceKey = checkpointText.parse(input.sourceKey);
    const watermark = input.watermark === undefined ? undefined : checkpointText.parse(input.watermark);
    let checkpoint = this.checkpoints.find((candidate) => candidate.routineId === run.routineId && candidate.source === source);
    if (checkpoint?.sourceKeys.includes(sourceKey)) {
      return { duplicate: true, checkpoint: cloneCheckpoint(checkpoint) };
    }
    this.commitMutation(() => {
      if (!checkpoint) {
        checkpoint = { routineId: run.routineId, source, sourceKeys: [], updatedAt: this.now() };
        this.checkpoints.push(checkpoint);
      }
      checkpoint.sourceKeys.push(sourceKey);
      checkpoint.sourceKeys = checkpoint.sourceKeys.slice(-MAX_CHECKPOINT_SOURCE_KEYS);
      if (watermark !== undefined) checkpoint.watermark = watermark;
      checkpoint.updatedAt = this.now();
    });
    return { duplicate: false, checkpoint: cloneCheckpoint(checkpoint!) };
  }

  routineRequestReceipt(requestId: string): RoutineRequestReceipt | null {
    const receipt = this.routineRequestReceipts.find((candidate) => candidate.requestId === requestId);
    return receipt ? { ...receipt } : null;
  }

  /** Small startup index used to locate only transcripts that may need
   * cross-file commit recovery. Most launches have no receipts and therefore
   * do not read or cache any transcript for this feature. */
  routineRequestReceiptOwners(): RoutineRequestOwner[] {
    return this.routineRequestReceipts.map(({ requestId, messageId, botId, threadId }) => ({
      requestId,
      messageId,
      botId,
      threadId,
    }));
  }

  /** Once the transcript card is durably settled, its scheduler receipt is
   * redundant. Unsettled receipts are intentionally never count-evicted: an
   * actionable card may survive indefinitely and must retain its exact-once
   * recovery record for the same lifetime. */
  forgetRoutineRequestReceipt(request: RoutineRequestCommit): boolean {
    const receipt = this.matchingRoutineRequestReceipt(request);
    if (!receipt) return false;
    const index = this.routineRequestReceipts.indexOf(receipt);
    this.commitMutation(() => {
      this.routineRequestReceipts.splice(index, 1);
    });
    return true;
  }

  forgetRoutineRequestReceiptsForThread(threadId: string): number {
    const kept = this.routineRequestReceipts.filter((receipt) => receipt.threadId !== threadId);
    const removed = this.routineRequestReceipts.length - kept.length;
    if (removed === 0) return 0;
    this.commitMutation(() => {
      this.routineRequestReceipts = kept;
    });
    return removed;
  }

  /** Drop only receipts whose confirmation transcript no longer exists.
   * Reachable open cards retain exact-once recovery for their full lifetime. */
  reconcileRoutineRequestReceipts(reachable: readonly RoutineRequestOwner[]): number {
    const keys = new Set(reachable.map(routineRequestOwnerKey));
    const kept = this.routineRequestReceipts.filter((receipt) => keys.has(routineRequestOwnerKey(receipt)));
    const removed = this.routineRequestReceipts.length - kept.length;
    if (removed === 0) return 0;
    this.commitMutation(() => {
      this.routineRequestReceipts = kept;
    });
    return removed;
  }

  isActiveThread(threadId: string): boolean {
    return this.runs.some(
      (run) => run.threadId === threadId && ["running", "waiting"].includes(run.status),
    );
  }

  create(input: RoutineInput, request?: RoutineRequestCommitFor<"create">): Routine {
    if (request) {
      const receipt = this.matchingRoutineRequestReceipt(request);
      if (receipt) {
        const committed = this.routines.find((routine) => routine.id === receipt.resultId);
        if (committed) return cloneRoutine(committed);
        throw new Error("This routine request was already applied");
      }
    }
    const clean = sanitizeInput(input);
    if (this.targetState(clean) === "missing") throw new Error(this.missingTargetMessage(clean.target));
    const at = this.now();
    const routine: Routine = {
      id: randomUUID(),
      ...clean,
      // Only a confirmed chat card supplies `request`; the public calendar
      // API cannot choose an arbitrary transcript as a reporting target.
      sourceThreadId: request?.threadId,
      nextRunAt: clean.enabled ? this.initialOccurrence(clean.schedule, at) : null,
      createdAt: at,
      updatedAt: at,
    };
    this.commitMutation(() => {
      this.routines.unshift(routine);
      if (request) this.rememberRoutineRequest(request, routine.id, at);
    });
    this.emitRoutine(routine);
    return cloneRoutine(routine);
  }

  update(
    id: string,
    patch: Partial<RoutineInput>,
    request?: RoutineRequestCommitFor<"update" | "pause" | "resume">,
  ): Routine | null {
    if (request) {
      const receipt = this.matchingRoutineRequestReceipt(request);
      if (receipt) {
        const committed = this.routines.find((routine) => routine.id === receipt.resultId);
        return committed ? cloneRoutine(committed) : null;
      }
    }
    const routine = this.routines.find((r) => r.id === id);
    if (!routine) return null;
    const now = this.now();
    const clean = sanitizeInput({
      name: patch.name ?? routine.name,
      prompt: patch.prompt ?? routine.prompt,
      target: patch.target ?? routine.target,
      botId: patch.botId ?? routine.botId,
      groupId: Object.hasOwn(patch, "groupId") ? patch.groupId : routine.groupId,
      runOn: patch.runOn ?? routine.runOn,
      enabled: patch.enabled ?? routine.enabled,
      schedule: patch.schedule ?? routine.schedule,
      durationMinutes: patch.durationMinutes ?? routine.durationMinutes,
      timeoutMinutes: Object.hasOwn(patch, "timeoutMinutes") ? patch.timeoutMinutes : routine.timeoutMinutes,
      attachments: patch.attachments ?? routine.attachments,
    });
    if (this.targetState(clean) === "missing") throw new Error(this.missingTargetMessage(clean.target));
    const cancelledRuns: RoutineRun[] = [];
    this.commitMutation(() => {
      Object.assign(routine, clean, {
        nextRunAt: clean.enabled ? this.initialOccurrence(clean.schedule, now) : null,
        // `updatedAt` doubles as the optimistic revision on durable routine
        // confirmation cards. Keep it monotonic even for two writes in one ms.
        updatedAt: Math.max(now, routine.updatedAt + 1),
      });
      if (Object.hasOwn(patch, "timeoutMinutes") && patch.timeoutMinutes == null) {
        delete routine.timeoutMinutes;
      }
      if (patch.enabled === false) {
        for (const run of this.runs) {
          if (run.routineId !== routine.id || run.status !== "queued") continue;
          run.status = "cancelled";
          run.attention = undefined;
          run.finishedAt = this.now();
          run.error = "The routine was paused before this run started";
          cancelledRuns.push(run);
        }
      }
      if (request) this.rememberRoutineRequest(request, routine.id, now);
    });
    for (const run of cancelledRuns) this.emitRun(run);
    this.emitRoutine(routine);
    return cloneRoutine(routine);
  }

  remove(id: string, request?: RoutineRequestCommitFor<"delete">): boolean {
    if (request) {
      const receipt = this.matchingRoutineRequestReceipt(request);
      if (receipt) {
        return true;
      }
    }
    const at = this.routines.findIndex((r) => r.id === id);
    if (at === -1) return false;
    const cancelledRuns: RoutineRun[] = [];
    this.commitMutation(() => {
      this.routines.splice(at, 1);
      for (const run of this.runs) {
        if (run.routineId !== id || run.status !== "queued") continue;
        run.status = "cancelled";
        run.attention = undefined;
        run.finishedAt = this.now();
        cancelledRuns.push(run);
      }
      if (request) this.rememberRoutineRequest(request, id, this.now());
    });
    for (const run of cancelledRuns) this.emitRun(run);
    this.options.emit?.({ kind: "routine.deleted", routineId: id });
    return true;
  }

  disableForBot(botId: string) {
    let changed = false;
    for (const routine of this.routines) {
      if (routine.botId !== botId || !routine.enabled) continue;
      routine.enabled = false;
      routine.nextRunAt = null;
      routine.updatedAt = Math.max(this.now(), routine.updatedAt + 1);
      this.emitRoutine(routine);
      changed = true;
    }
    for (const run of this.runs) {
      if (run.botId !== botId || !["queued", "running", "waiting"].includes(run.status)) continue;
      run.status = "cancelled";
      if (run.target === "room-goal") run.goalStatus = "stopped";
      run.attention = undefined;
      run.finishedAt = this.now();
      run.error = "The assigned bot was deleted";
      this.emitRun(run);
      if (run.threadId) {
        if (run.target === "room-goal" && run.groupId) {
          void this.options.interruptGoal?.(run.groupId, run.threadId).catch(() => {});
        } else {
          void this.options.interruptTurn?.(run.botId, run.threadId, run.runOn ?? "maus").catch(() => {});
        }
      }
      changed = true;
    }
    if (changed) this.save();
  }

  disableForGroup(groupId: string) {
    let changed = false;
    for (const routine of this.routines) {
      if (routine.target !== "room-goal" || routine.groupId !== groupId || !routine.enabled) continue;
      routine.enabled = false;
      routine.nextRunAt = null;
      routine.updatedAt = Math.max(this.now(), routine.updatedAt + 1);
      this.emitRoutine(routine);
      changed = true;
    }
    for (const run of this.runs) {
      if (
        run.target !== "room-goal" ||
        run.groupId !== groupId ||
        !["queued", "running", "waiting"].includes(run.status)
      ) continue;
      run.status = "cancelled";
      run.goalStatus = "stopped";
      run.attention = undefined;
      run.finishedAt = this.now();
      run.error = "The assigned room was deleted";
      this.emitRun(run);
      if (run.threadId) {
        void this.options.interruptGoal?.(groupId, run.threadId).catch(() => {});
      }
      changed = true;
    }
    if (changed) this.save();
  }

  runNow(id: string, request?: RoutineRequestCommitFor<"run_now">): RoutineRun | null {
    if (request) {
      const receipt = this.matchingRoutineRequestReceipt(request);
      if (receipt) {
        const committed = this.runs.find((run) => run.id === receipt.resultId);
        return committed ? cloneRun(committed) : null;
      }
    }
    const routine = this.routines.find((r) => r.id === id);
    if (!routine) return null;
    let run!: RoutineRun;
    this.commitMutation(() => {
      run = this.newRun(routine, this.now(), true);
      // A chat-confirmed "run now" reports back to the conversation that
      // invoked this one run. It must not silently rebind future schedules.
      if (request) run.sourceThreadId = request.threadId;
      if (request) this.rememberRoutineRequest(request, run.id, this.now());
    });
    this.emitRun(run);
    queueMicrotask(() => void this.tick());
    return cloneRun(run);
  }

  /** Queue an event-driven job without inventing a calendar schedule. Webhook
   * definitions live in their own store; the execution receipt deliberately
   * reuses this manager so busy-bot ordering, task creation and VM routing stay
   * identical for every unattended job. */
  enqueueWebhook(input: {
    webhookId: string;
    webhookName: string;
    prompt: string;
    botId: string;
    runOn: RoutineRunOn;
    deliveryId: string;
    receivedAt: number;
  }): RoutineRun {
    if (this.options.botState(input.botId) === "missing") {
      throw Object.assign(new Error("The assigned MAUS no longer exists"), { status: 410 });
    }
    const run: RoutineRun = {
      id: randomUUID(),
      routineId: input.webhookId,
      routineName: input.webhookName,
      prompt: input.prompt,
      target: "bot",
      botId: input.botId,
      runOn: input.runOn,
      scheduledFor: input.receivedAt,
      status: "queued",
      manual: false,
      triggerSource: "webhook",
      webhookId: input.webhookId,
      deliveryId: input.deliveryId,
      attachments: [],
      createdAt: this.now(),
    };
    this.runs.push(run);
    this.save();
    this.emitRun(run);
    queueMicrotask(() => void this.tick());
    return cloneRun(run);
  }

  activeWebhookRunCount(webhookId: string): number {
    return this.runs.filter(
      (run) => run.webhookId === webhookId && ["queued", "running", "waiting"].includes(run.status),
    ).length;
  }

  cancelQueuedWebhook(webhookId: string, message: string): void {
    let changed = false;
    for (const run of this.runs) {
      if (run.webhookId !== webhookId || run.status !== "queued") continue;
      run.status = "cancelled";
      run.attention = undefined;
      run.finishedAt = this.now();
      run.error = message.slice(0, 500);
      this.emitRun(run);
      changed = true;
    }
    if (changed) this.save();
  }

  async cancelRun(id: string): Promise<RoutineRun | null> {
    const run = this.runs.find((r) => r.id === id);
    if (!run || !["queued", "running", "waiting"].includes(run.status)) return null;
    run.status = "cancelled";
    if (run.target === "room-goal") run.goalStatus = "stopped";
    run.attention = undefined;
    run.finishedAt = this.now();
    this.save();
    this.emitRun(run);
    if (run.threadId) {
      if (run.target === "room-goal" && run.groupId) {
        await this.options.interruptGoal?.(run.groupId, run.threadId).catch(() => {});
      } else {
        await this.options.interruptTurn?.(run.botId, run.threadId, run.runOn ?? "maus").catch(() => {});
      }
    }
    queueMicrotask(() => void this.tick());
    return cloneRun(run);
  }

  markSeen(id: string): RoutineRun | null {
    const run = this.runs.find((r) => r.id === id);
    if (!run) return null;
    if (!run.seenAt) {
      run.seenAt = this.now();
      this.save();
      this.emitRun(run);
    }
    return cloneRun(run);
  }

  start() {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 10_000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      for (const run of this.runs) {
        if (
          !["running", "waiting"].includes(run.status) ||
          run.startedAt == null ||
          run.timeoutMinutes == null ||
          now - run.startedAt < run.timeoutMinutes * 60_000
        ) continue;
        const threadId = run.threadId;
        const detail = `Stopped after reaching the ${run.timeoutMinutes}-minute run limit`;
        if (run.target === "room-goal") run.goalStatus = "limit-reached";
        this.failRun(run, detail);
        if (!threadId) continue;
        if (run.target === "room-goal" && run.groupId) {
          await this.options.interruptGoal?.(run.groupId, threadId, {
            status: "limit-reached",
            detail,
          }).catch(() => {});
        } else {
          await this.options.interruptTurn?.(run.botId, threadId, run.runOn ?? "maus").catch(() => {});
        }
      }
      let changed = false;
      const missedRuns: RoutineRun[] = [];
      for (const routine of this.routines) {
        if (!routine.enabled || routine.nextRunAt == null || routine.nextRunAt > now) continue;
        const pendingAt = routine.nextRunAt;
        const late = now - pendingAt;
        const scheduledFor = routine.schedule.type === "interval" && late <= CATCH_UP_MS
          ? latestIntervalOccurrence(routine.schedule, now) ?? pendingAt
          : pendingAt;
        // One slow interval run must not build an unbounded queue of stale
        // copies behind it. The series still advances on its original phase.
        const overlapping = routine.schedule.type === "interval" && this.runs.some(
          (run) => run.routineId === routine.id && ["queued", "running", "waiting"].includes(run.status),
        );
        if (!overlapping) {
          if (late > CATCH_UP_MS) {
            const missed = this.newRun(routine, scheduledFor, false);
            missed.status = "missed";
            missed.finishedAt = now;
            missed.error = "This computer was offline for more than 12 hours after the scheduled time";
            this.emitRun(missed);
            missedRuns.push(cloneRun(missed));
          } else {
            const run = this.newRun(routine, scheduledFor, false);
            this.emitRun(run);
          }
        }
        routine.nextRunAt =
          routine.schedule.type === "once" ? null : nextOccurrence(routine.schedule, Math.max(now, scheduledFor));
        // `updatedAt` is the optimistic definition revision carried by
        // routine confirmation cards. Moving the scheduler cursor is runtime
        // progress, not a definition edit, so recurring ticks must not make a
        // still-accurate pending confirmation stale. A one-time routine does
        // mutate its definition by auto-disabling after its occurrence.
        if (routine.schedule.type === "once") {
          routine.enabled = false;
          routine.updatedAt = Math.max(now, routine.updatedAt + 1);
        }
        this.emitRoutine(routine);
        changed = true;
      }
      if (changed) this.save();
      for (const missed of missedRuns) this.options.onRunFailed?.(missed);

      for (const run of [...this.runs].reverse()) {
        if (run.status !== "queued") continue;
        // A queued interval represents the latest useful check, not a backlog
        // item. If the bot stayed busy across later occurrences, align this
        // scheduled receipt to the newest due point immediately before it can
        // dispatch. Manual runs and webhook deliveries retain their exact
        // requested/received timestamps.
        const triggerSource = run.triggerSource ?? (run.manual ? "manual" : "schedule");
        const definition = triggerSource === "schedule"
          ? this.routines.find((routine) => routine.id === run.routineId)
          : undefined;
        if (definition?.schedule.type === "interval") {
          const latest = latestIntervalOccurrence(definition.schedule, now);
          if (latest !== null && latest > run.scheduledFor) {
            run.scheduledFor = latest;
            this.save();
            this.emitRun(run);
          }
        }
        const state = this.targetState(run);
        if (state === "busy") continue;
        if (state === "missing") {
          this.failRun(run, this.missingTargetMessage(run.target));
          continue;
        }
        // A webhook is an incoming message, so make its task the bot's live
        // chat immediately. Scheduled work remains detached and unobtrusive.
        const task = run.target === "room-goal"
          ? run.groupId
            ? this.options.createGoalTask?.(run.groupId, run.routineName) ?? null
            : null
          : this.options.createTask(run.botId, run.routineName, run.triggerSource === "webhook");
        if (!task) {
          this.failRun(run, run.target === "room-goal"
            ? "Could not create a room task for this goal"
            : "Could not create a task for this run");
          continue;
        }
        run.threadId = task.threadId;
        run.startedAt = this.now();
        run.status = "running";
        this.save();
        this.emitRun(run);
        try {
          const prompt = run.prompt ?? this.routines.find((r) => r.id === run.routineId)?.prompt;
          if (!prompt) {
            this.failThread(task.threadId, "The routine was deleted before it could start");
            continue;
          }
          const triggerSource = run.triggerSource ?? (run.manual ? "manual" : "schedule");
          if (run.target === "room-goal") {
            if (!run.groupId || !this.options.startGoal) {
              this.failThread(task.threadId, "Room goal routines are unavailable");
              continue;
            }
            await this.options.startGoal(
              run.groupId,
              task.threadId,
              prompt,
              run.botId,
              run.id,
              run.routineId,
              run.timeoutMinutes,
              (message) => this.failThread(task.threadId, message),
            );
          } else {
            await this.options.startTurn(
              run.botId,
              task.threadId,
              composeExecutionPrompt(prompt, run.attachments),
              run.runOn ?? "maus",
              triggerSource,
              run.routineId,
              (message) => this.failThread(task.threadId, message),
            );
          }
        } catch (error) {
          this.failThread(task.threadId, error instanceof Error ? error.message : String(error));
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  handleRuntimeEvent(event: RuntimeEvent): RoutineRun | null {
    const run = this.runs.find((r) => r.threadId === event.threadId && ["running", "waiting"].includes(r.status));
    if (!run) return null;
    // A room goal contains several provider turns. Its orchestrator owns the
    // terminal decision and reports it through finishGoalRun; one member's
    // completion and private coordinator envelope are only intermediate
    // protocol, never the routine receipt's result.
    if (
      run.target === "room-goal" &&
      (event.type === "turn.completed" || (event.type === "item.completed" && event.itemType === "assistant_text"))
    ) return null;
    if (event.type === "request.opened") {
      run.status = "waiting";
      run.attention = redactSecretsInText(event.summary).trim().slice(0, 500) || undefined;
    } else if (event.type === "request.resolved") {
      run.status = "running";
      run.attention = undefined;
    } else if (event.type === "item.completed" && event.itemType === "assistant_text") {
      run.output = redactSecretsInText(event.text).trim().slice(0, 2_000);
    } else if (event.type === "runtime.error") {
      run.error = redactSecretsInText(event.message).slice(0, 500);
    } else if (event.type === "turn.retrying") {
      // the driver will relaunch this same run; a transient blip is not a
      // receipt-worthy failure, so keep the run running and stay quiet
      return null;
    } else if (event.type === "turn.completed") {
      run.cost = event.cost;
      run.denials = event.denials;
      if (!event.ok) {
        this.failRun(run, event.stopReason ?? run.error ?? "The bot did not complete this run");
        queueMicrotask(() => void this.tick());
        return cloneRun(run);
      }
      run.status = "completed";
      run.attention = undefined;
      run.finishedAt = this.now();
      run.error = undefined;
    } else {
      return null;
    }
    this.save();
    this.emitRun(run);
    if (event.type === "turn.completed") queueMicrotask(() => void this.tick());
    return cloneRun(run);
  }

  failThread(threadId: string, message: string) {
    const run = this.runs.find((r) => r.threadId === threadId && ["running", "waiting"].includes(r.status));
    if (!run) return;
    this.failRun(run, message);
    queueMicrotask(() => void this.tick());
  }

  finishGoalRun(runId: string, status: GroupGoalRunStatus, detail: string): RoutineRun | null {
    const run = this.runs.find(
      (candidate) => candidate.id === runId &&
        candidate.target === "room-goal" &&
        ["running", "waiting"].includes(candidate.status),
    );
    if (!run || status === "working") return null;
    const safeDetail = redactSecretsInText(detail).trim();
    run.goalStatus = status;
    // Only a completed goal is a completed run. A team asking the human a
    // question is still waiting on them, and a blocked or turn-capped goal
    // did not finish — reporting either as "completed" would silence the
    // one outcome that most needs a person's attention.
    if (status === "failed" || status === "blocked" || status === "limit-reached") {
      this.failRun(
        run,
        safeDetail ||
          (status === "limit-reached" ? "The room goal reached its turn limit" : "The room goal is blocked"),
      );
    } else if (status === "needs-input" || status === "paused") {
      run.status = "waiting";
      run.attention = safeDetail.slice(0, 500) || (status === "paused" ? "The room goal is paused" : "The team needs your input");
      run.error = undefined;
      this.save();
      this.emitRun(run);
    } else {
      run.status = status === "stopped" ? "cancelled" : "completed";
      run.attention = undefined;
      run.finishedAt = this.now();
      run.error = undefined;
      if (status !== "stopped") run.output = safeDetail.slice(0, 2_000) || undefined;
      this.save();
      this.emitRun(run);
    }
    queueMicrotask(() => void this.tick());
    return cloneRun(run);
  }

  private failRun(run: RoutineRun, message: string) {
    run.status = "failed";
    run.attention = undefined;
    run.error = redactSecretsInText(message).slice(0, 500);
    run.finishedAt = this.now();
    this.save();
    this.emitRun(run);
    this.options.onRunFailed?.(cloneRun(run));
  }

  private targetState(target: Pick<RoutineRun, "target" | "groupId" | "botId">): "ready" | "busy" | "missing" {
    if (target.target === "room-goal") {
      if (!target.groupId || !this.options.goalState) return "missing";
      return this.options.goalState(target.groupId, target.botId);
    }
    return this.options.botState(target.botId);
  }

  private checkpointRun(threadId: string, botId: string): RoutineRun {
    const run = this.runs.find((candidate) =>
      candidate.threadId === threadId &&
      (candidate.target === "room-goal" || candidate.botId === botId) &&
      ["running", "waiting"].includes(candidate.status));
    if (!run) throw new Error("routine checkpoint access requires the active owning run");
    return run;
  }

  private missingTargetMessage(target: RoutineTarget): string {
    return target === "room-goal"
      ? "The assigned room or coordinator no longer exists"
      : "The assigned bot no longer exists";
  }

  private initialOccurrence(schedule: RoutineSchedule, now: number): number | null {
    // Return the original time, not max(at, now): tick() already decides
    // whether a stale "once" run fires or is recorded as "missed" based on
    // how far past the scheduled time it is. Clamping to now here hides the
    // original schedule from the run receipt (scheduledFor would read "now"
    // instead of the time the user chose) and prevents the 12-hour missed
    // threshold from ever triggering for a "once" routine created late.
    if (schedule.type === "once") return schedule.at;
    return nextOccurrence(schedule, now);
  }

  private newRun(routine: Routine, scheduledFor: number, manual: boolean): RoutineRun {
    const run: RoutineRun = {
      id: randomUUID(),
      routineId: routine.id,
      routineName: routine.name,
      prompt: routine.prompt,
      durationMinutes: routine.durationMinutes,
      ...(routine.timeoutMinutes === undefined ? {} : { timeoutMinutes: routine.timeoutMinutes }),
      attachments: cloneAttachments(routine.attachments),
      target: routine.target,
      groupId: routine.groupId,
      botId: routine.botId,
      runOn: routine.runOn ?? "maus",
      scheduledFor,
      status: "queued",
      manual,
      triggerSource: manual ? "manual" : "schedule",
      sourceThreadId: routine.sourceThreadId,
      createdAt: this.now(),
    };
    this.runs.push(run);
    return run;
  }

  private emitRoutine(routine: Routine) {
    this.options.emit?.({ kind: "routine", routine: cloneRoutine(routine) });
  }

  private emitRun(run: RoutineRun) {
    this.options.emit?.({ kind: "routine.run", run: cloneRun(run) });
    this.notifyRunChanged(run);
  }

  private notifyRunChanged(run: RoutineRun) {
    try {
      this.options.onRunChanged?.(cloneRun(run));
    } catch (error) {
      // Reporting is secondary to scheduler truth. A transcript write must
      // never strand the run in memory or prevent the next tick.
      console.error("routine: source-thread lifecycle update failed", error);
    }
  }

  private matchingRoutineRequestReceipt(request: RoutineRequestCommit): RoutineRequestReceipt | null {
    const receipt = this.routineRequestReceipts.find((candidate) => candidate.requestId === request.requestId);
    if (!receipt) return null;
    if (
      receipt.action !== request.action ||
      receipt.messageId !== request.messageId ||
      receipt.botId !== request.botId ||
      receipt.threadId !== request.threadId ||
      receipt.fingerprintVersion !== request.fingerprintVersion ||
      receipt.fingerprint !== request.fingerprint
    ) {
      throw new Error("Routine request receipt does not match this confirmation card");
    }
    return receipt;
  }

  private rememberRoutineRequest(
    request: RoutineRequestCommit,
    resultId: string,
    appliedAt: number,
  ) {
    const existing = this.matchingRoutineRequestReceipt(request);
    if (existing) {
      if (existing.resultId !== resultId) throw new Error("Routine request receipt has another result");
      return;
    }
    this.routineRequestReceipts.unshift({ ...request, resultId, appliedAt });
  }

  /**
   * A confirmation receipt is only true once the scheduler mutation and its
   * receipt reached the same atomic file. Restore the complete in-memory
   * state if writing or renaming that file fails so a retry cannot mistake an
   * uncommitted action for a durable one.
   */
  private commitMutation(mutate: () => void): void {
    const before = {
      routines: this.routines.map(cloneRoutine),
      runs: this.runs.map(cloneRun),
      receipts: this.routineRequestReceipts.map((receipt) => ({ ...receipt })),
      checkpoints: this.checkpoints.map(cloneCheckpoint),
    };
    try {
      mutate();
      this.save();
    } catch (error) {
      this.routines = before.routines;
      this.runs = before.runs;
      this.routineRequestReceipts = before.receipts;
      this.checkpoints = before.checkpoints;
      throw error;
    }
  }

  private save() {
    // Active receipts own cancellation, timeout, and provider-event routing;
    // evicting one would strand live work. Treat MAX_RUNS as a soft history
    // cap and reclaim only the oldest terminal receipts. An unusually large
    // active queue may exceed it until work settles.
    let excess = this.runs.length - MAX_RUNS;
    for (let index = 0; index < this.runs.length && excess > 0;) {
      if (["queued", "running", "waiting"].includes(this.runs[index]!.status)) {
        index += 1;
        continue;
      }
      this.runs.splice(index, 1);
      excess -= 1;
    }
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify({
      version: 1,
      routines: this.routines,
      runs: this.runs,
      routineRequestReceipts: this.routineRequestReceipts,
      checkpoints: this.checkpoints,
    } satisfies RoutineFile, null, 2), { mode: 0o600 });
  }
}
