// app/src/lib/date.ts
var DAY_MS = 24 * 60 * 60 * 1e3;
function parseFlexible(input) {
  if (!input) return /* @__PURE__ */ new Date(NaN);
  const text = input.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [y, m, d] = text.split("-").map((part) => Number(part));
    return new Date(y, m - 1, d, 0, 0, 0, 0);
  }
  return new Date(text);
}
function startOfDay(input) {
  const base = typeof input === "string" ? parseFlexible(input) : new Date(input.getTime());
  if (isNaN(base.getTime())) return /* @__PURE__ */ new Date(NaN);
  const d = new Date(base.getTime());
  d.setHours(0, 0, 0, 0);
  return d;
}
function toDateISO(d) {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function daysBetween(from, to) {
  const a = startOfDay(from);
  const b = startOfDay(to);
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return 0;
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}
function isSameDay(a, b) {
  return toDateISO(startOfDay(a)) === toDateISO(startOfDay(b));
}
function weekdayOf(d) {
  const w = d.getDay();
  return w === 0 ? 7 : w;
}
var WEEKDAY_CN = ["\u5468\u4E00", "\u5468\u4E8C", "\u5468\u4E09", "\u5468\u56DB", "\u5468\u4E94", "\u5468\u516D", "\u5468\u65E5"];
function fmtDate(value, placeholder = "\u2014") {
  if (!value) return placeholder;
  const d = parseFlexible(value);
  if (isNaN(d.getTime())) return placeholder;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
function fmtTime(value) {
  const d = parseFlexible(value);
  if (isNaN(d.getTime())) return "--:--";
  return `${`${d.getHours()}`.padStart(2, "0")}:${`${d.getMinutes()}`.padStart(2, "0")}`;
}
function timeToMinutes(hhmm) {
  if (!/^\d{1,2}:\d{2}$/.test(hhmm)) return NaN;
  const [h, m] = hhmm.split(":").map((p) => Number(p));
  return h * 60 + m;
}

// app/src/lib/rules.ts
var STATUS_LABEL = {
  wishlist: "\u60F3\u6295",
  applied: "\u5DF2\u6295\u9012",
  chatting: "\u5DF2\u6C9F\u901A",
  scheduled: "\u5DF2\u7EA6\u9762",
  interviewing: "\u9762\u8BD5\u4E2D",
  offer: "\u5DF2\u53D1 Offer",
  onboarded: "\u5DF2\u5165\u804C",
  rejected: "\u5DF2\u6302",
  dropped: "\u5DF2\u653E\u5F03"
};
var BOARD_COLUMNS = [
  "wishlist",
  "applied",
  "chatting",
  "scheduled",
  "interviewing",
  "offer"
];
var ENDED_STATUSES = ["onboarded", "rejected", "dropped"];
var SILENCE_STATUSES = ["applied", "chatting", "interviewing"];
var ALL_STATUSES = [...BOARD_COLUMNS, ...ENDED_STATUSES];
function lastActivityAtOf(app, notes) {
  let latest = app.statusChangedAt || app.createdAt;
  let latestMs = parseFlexible(latest).getTime();
  if (!Number.isFinite(latestMs)) latestMs = 0;
  for (const note of notes) {
    if (note.applicationId !== app.id) continue;
    const ms = parseFlexible(note.touchedAt).getTime();
    if (Number.isFinite(ms) && ms > latestMs) {
      latestMs = ms;
      latest = note.touchedAt;
    }
  }
  return latest;
}
function silenceDaysOf(app, notes, now = /* @__PURE__ */ new Date()) {
  const last = lastActivityAtOf(app, notes);
  const diff = daysBetween(last, now);
  return diff > 0 ? diff : 0;
}
function channelFactorOf(app, settings) {
  const channel = app.channel;
  if (!channel) return 1;
  const factor = settings.channelFactor[channel];
  return typeof factor === "number" && factor > 0 ? factor : 1;
}
function effectiveWarnDays(app, settings) {
  const warnBase = Math.max(1, settings.warnAfterDays);
  if (app.silenceOverride !== null && app.silenceOverride !== void 0) {
    return Math.max(1, Math.min(warnBase, Math.ceil(app.silenceOverride * 0.5)));
  }
  return Math.ceil(warnBase * channelFactorOf(app, settings));
}
function effectiveStaleDays(app, settings) {
  if (app.silenceOverride !== null && app.silenceOverride !== void 0) {
    return Math.max(1, app.silenceOverride);
  }
  const base = app.status === "interviewing" ? settings.interviewResultWaitDays : settings.staleAfterDays;
  return Math.ceil(Math.max(1, base) * channelFactorOf(app, settings));
}
function silenceStateOf(app, notes, settings, now = /* @__PURE__ */ new Date()) {
  if (!SILENCE_STATUSES.includes(app.status)) {
    return { days: 0, level: null, text: "" };
  }
  const days = silenceDaysOf(app, notes, now);
  const warnAt = effectiveWarnDays(app, settings);
  const staleAt = effectiveStaleDays(app, settings);
  if (days >= staleAt) {
    return {
      days,
      level: "stale",
      text: app.status === "interviewing" ? `\u7B49\u7ED3\u679C ${days} \u5929` : `\u5DF2\u6C89\u9ED8 ${days} \u5929`
    };
  }
  if (days >= warnAt) {
    return { days, level: "warn", text: `\u8BE5\u8DDF\u8FDB\u4E86 \xB7 ${days} \u5929` };
  }
  return { days, level: null, text: `\u6700\u8FD1\u6709\u4E92\u52A8 \xB7 ${days} \u5929` };
}
function wishlistExpiredDays(app, settings, now = /* @__PURE__ */ new Date()) {
  if (app.status !== "wishlist") return null;
  const days = daysBetween(app.createdAt, now);
  if (days >= Math.max(1, settings.wishlistExpireDays)) return days;
  return null;
}
function interviewPhaseLabel(interview, now, settings) {
  if (interview.result !== "pending") return "";
  const start = parseFlexible(interview.scheduledAt).getTime();
  if (!Number.isFinite(start)) return "";
  const end = start + durationOf(interview) * 60 * 1e3;
  const nowMs = now.getTime();
  if (nowMs < start) return "";
  if (nowMs < end) return "\u9762\u8BD5\u8FDB\u884C\u4E2D";
  const promptHour = settings.resultPromptHour ?? 20;
  if (isSameDay(now, interview.scheduledAt) && now.getHours() < promptHour) {
    return "\u5DF2\u7ED3\u675F\uFF0C\u7A0D\u540E\u8BB0\u7ED3\u679C";
  }
  return "\u5DF2\u7ED3\u675F\uFF0C\u5F85\u8BB0\u7ED3\u679C";
}
function buildTodos(db, now = /* @__PURE__ */ new Date()) {
  const appIndex = /* @__PURE__ */ new Map();
  for (const app of db.applications) appIndex.set(app.id, app);
  const stale = [];
  const warn = [];
  const wishlistExpired = [];
  for (const app of db.applications) {
    const state = silenceStateOf(app, db.notes, db.settings, now);
    if (state.level === "stale") stale.push({ app, days: state.days, level: "stale" });
    else if (state.level === "warn") warn.push({ app, days: state.days, level: "warn" });
    const expired = wishlistExpiredDays(app, db.settings, now);
    if (expired !== null) wishlistExpired.push({ app, days: expired, level: "warn" });
  }
  const todayInterview = [];
  const needResult = [];
  const promptHour = db.settings.resultPromptHour ?? 20;
  for (const interview of db.interviews) {
    const app = appIndex.get(interview.applicationId);
    if (!app) continue;
    if (ENDED_STATUSES.includes(app.status)) continue;
    const at2 = parseFlexible(interview.scheduledAt);
    if (isNaN(at2.getTime())) continue;
    const today = isSameDay(at2, now);
    const passed = at2.getTime() < now.getTime();
    const promptReached = !today || now.getHours() >= promptHour;
    if (interview.result === "pending" && passed && promptReached) {
      needResult.push({ interview, app, at: at2 });
      continue;
    }
    if (today) {
      todayInterview.push({ interview, app, at: at2 });
    }
  }
  stale.sort((a, b) => b.days - a.days);
  warn.sort((a, b) => b.days - a.days);
  wishlistExpired.sort((a, b) => b.days - a.days);
  todayInterview.sort((a, b) => a.at.getTime() - b.at.getTime());
  needResult.sort((a, b) => a.at.getTime() - b.at.getTime());
  return { stale, warn, todayInterview, needResult, wishlistExpired };
}
function buildActionItems(todos, companies, settings, now = /* @__PURE__ */ new Date()) {
  const nameOf = (companyId) => {
    const found = companies.find((c) => c.id === companyId);
    return found ? found.shortName || found.name : "\u672A\u77E5\u516C\u53F8";
  };
  const items = [];
  for (const item of todos.stale) {
    items.push({
      key: `stale_${item.app.id}`,
      kind: "stale",
      appId: item.app.id,
      title: `${nameOf(item.app.companyId)} \xB7 ${item.app.jobTitle}`,
      detail: `${item.app.status === "interviewing" ? "\u7B49\u7ED3\u679C" : "\u6C89\u9ED8"} ${item.days} \u5929\uFF0C\u673A\u4F1A\u5728\u6D41\u5931`,
      tone: "red",
      doneHint: "\u50AC\u4E00\u4E0B"
    });
  }
  for (const item of todos.todayInterview) {
    const phase = interviewPhaseLabel(item.interview, now, settings);
    items.push({
      key: `today_${item.interview.id}`,
      kind: "interview",
      appId: item.app.id,
      interviewId: item.interview.id,
      title: `${fmtTime(item.interview.scheduledAt)} ${nameOf(item.app.companyId)} \xB7 ${item.app.jobTitle}`,
      detail: `\u7B2C ${item.interview.round} \u8F6E\u9762\u8BD5${item.interview.locationOrLink ? ` \xB7 ${item.interview.locationOrLink}` : ""}${phase ? ` \xB7 ${phase}` : ""}`,
      tone: "blue",
      doneHint: "\u770B\u51C6\u5907\u6E05\u5355"
    });
  }
  for (const item of todos.needResult) {
    items.push({
      key: `result_${item.interview.id}`,
      kind: "result",
      appId: item.app.id,
      interviewId: item.interview.id,
      title: `${nameOf(item.app.companyId)} \xB7 ${item.app.jobTitle}`,
      detail: `${fmtDate(item.interview.scheduledAt)} \u90A3\u573A\u9762\u8BD5\u8FD8\u6CA1\u8BB0\u7ED3\u679C`,
      tone: "blue",
      doneHint: "\u53BB\u8BB0\u7ED3\u679C"
    });
  }
  for (const item of todos.warn) {
    items.push({
      key: `warn_${item.app.id}`,
      kind: "warn",
      appId: item.app.id,
      title: `${nameOf(item.app.companyId)} \xB7 ${item.app.jobTitle}`,
      detail: `${item.days} \u5929\u6CA1\u52A8\u9759\uFF0C\u53EF\u4EE5\u8F7B\u50AC\u4E00\u53E5`,
      tone: "amber",
      doneHint: "\u50AC\u4E00\u4E0B"
    });
  }
  for (const item of todos.wishlistExpired) {
    items.push({
      key: `wish_${item.app.id}`,
      kind: "wishlist",
      appId: item.app.id,
      title: `${nameOf(item.app.companyId)} \xB7 ${item.app.jobTitle}`,
      detail: `\u653E\u5728\u60F3\u6295\u91CC ${item.days} \u5929\u4E86\uFF0C\u8FD8\u60F3\u6295\u5417\uFF1F`,
      tone: "amber",
      doneHint: "\u505A\u4E2A\u51B3\u5B9A"
    });
  }
  return items;
}
function stageRankOf(app, interviews) {
  switch (app.status) {
    case "wishlist":
      return 0;
    case "applied":
      return 1;
    case "chatting":
      return 2;
    case "scheduled":
      return 3;
    case "interviewing":
      return 4;
    case "offer":
    case "onboarded":
      return 5;
    case "rejected":
    case "dropped": {
      const own = interviews.filter((i) => i.applicationId === app.id);
      if (own.some((i) => i.result === "passed" || i.result === "failed")) return 3;
      if (own.length > 0) return 3;
      return app.appliedAt ? 1 : 0;
    }
    default:
      return 0;
  }
}
function buildFunnel(db) {
  const defs = [
    { key: "wishlist", label: "\u60F3\u6295", rank: 0 },
    { key: "applied", label: "\u5DF2\u6295\u9012", rank: 1 },
    { key: "chatting", label: "\u5DF2\u6C9F\u901A", rank: 2 },
    { key: "scheduled", label: "\u5DF2\u7EA6\u9762", rank: 3 },
    { key: "interviewing", label: "\u9762\u8BD5\u4E2D", rank: 4 },
    { key: "offer", label: "Offer", rank: 5 }
  ];
  const ranks = db.applications.map((app) => stageRankOf(app, db.interviews));
  return defs.map((def, index) => {
    const count = ranks.filter((r) => r >= def.rank).length;
    const prev = index === 0 ? count : ranks.filter((r) => r >= defs[index - 1].rank).length;
    const rate = index === 0 ? count > 0 ? 1 : 0 : prev > 0 ? count / prev : 0;
    return { key: def.key, label: def.label, count, rate };
  });
}
function buildChannelStats(db) {
  const buckets = /* @__PURE__ */ new Map();
  for (const app of db.applications) {
    const channel = app.channel || "other";
    if (!buckets.has(channel)) buckets.set(channel, { total: 0, replied: 0 });
    const bucket = buckets.get(channel);
    if (!bucket) continue;
    bucket.total += 1;
    if (stageRankOf(app, db.interviews) >= 2) bucket.replied += 1;
  }
  return [...buckets.entries()].map(([channel, v]) => ({
    channel,
    total: v.total,
    replied: v.replied,
    rate: v.total > 0 ? v.replied / v.total : 0
  })).sort((a, b) => b.total - a.total);
}
function buildResumeStats(db) {
  const interviewAppIds = new Set(db.interviews.map((i) => i.applicationId));
  const buckets = /* @__PURE__ */ new Map();
  for (const app of db.applications) {
    const version = app.resumeVersion || "\u672A\u6807\u6CE8";
    if (!buckets.has(version)) buckets.set(version, { total: 0, interviewed: 0 });
    const bucket = buckets.get(version);
    if (!bucket) continue;
    bucket.total += 1;
    if (interviewAppIds.has(app.id)) bucket.interviewed += 1;
  }
  return [...buckets.entries()].map(([version, v]) => ({
    version,
    total: v.total,
    interviewed: v.interviewed,
    rate: v.total > 0 ? v.interviewed / v.total : 0
  })).sort((a, b) => b.total - a.total);
}
function durationOf(interview) {
  return interview.durationMin && interview.durationMin > 0 ? interview.durationMin : 60;
}
function intervalOf(interview) {
  const start = parseFlexible(interview.scheduledAt);
  const startMs = start.getHours() * 60 + start.getMinutes();
  return { start: startMs, end: startMs + durationOf(interview) };
}
function overlap(a, b) {
  return a.start < b.end && b.start < a.end;
}
function findConflicts(target, interviews, applications, settings) {
  const messages = [];
  const targetAt = parseFlexible(target.scheduledAt);
  if (isNaN(targetAt.getTime())) return messages;
  const targetInterval = intervalOf(target);
  const appIndex = /* @__PURE__ */ new Map();
  for (const app of applications) appIndex.set(app.id, app);
  for (const other of interviews) {
    if (other.id === target.id) continue;
    if (other.result === "cancelled") continue;
    const otherAt = parseFlexible(other.scheduledAt);
    if (isNaN(otherAt.getTime())) continue;
    if (!isSameDay(otherAt, targetAt)) continue;
    if (!overlap(targetInterval, intervalOf(other))) continue;
    const app = appIndex.get(other.applicationId);
    const name = app ? app.jobTitle : "\u5176\u4ED6\u9762\u8BD5";
    messages.push(`\u4E0E ${fmtTime(other.scheduledAt)} \u7684\u53E6\u4E00\u573A\u9762\u8BD5\u65F6\u95F4\u91CD\u53E0\uFF08${name}\uFF09`);
  }
  const weekday = weekdayOf(targetAt);
  for (const slot of settings.courseSlots) {
    if (slot.weekday !== weekday) continue;
    const startMin = timeToMinutes(slot.start);
    const endMin = timeToMinutes(slot.end);
    if (!Number.isFinite(startMin) || !Number.isFinite(endMin)) continue;
    if (!overlap(targetInterval, { start: startMin, end: endMin })) continue;
    messages.push(
      `\u4E0E\u300A${slot.name || "\u8BFE\u7A0B"}\u300B\u51B2\u7A81\uFF08${WEEKDAY_CN[slot.weekday - 1]} ${slot.start}-${slot.end}\uFF09`
    );
  }
  return messages;
}
function statusChangeText(from, to) {
  return `\u72B6\u6001\uFF1A${STATUS_LABEL[from]} \u2192 ${STATUS_LABEL[to]}`;
}
function revertStatusChange(draft, undo) {
  draft.notes = draft.notes.filter((note) => note.id !== undo.createdNoteId);
  const target = draft.applications.find((app) => app.id === undo.appId);
  if (!target) return;
  target.status = undo.prevStatus;
  target.statusChangedAt = undo.prevStatusChangedAt;
  target.rejectedAtRound = undo.prevRejectedAtRound;
  target.lastActivityAt = lastActivityAtOf(target, draft.notes);
  target.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
}

// app/src/lib/storage.ts
var STORAGE_KEY = "jobdesk.v1";
function defaultSettings() {
  return {
    schemaVersion: 1,
    warnAfterDays: 3,
    staleAfterDays: 7,
    interviewResultWaitDays: 5,
    wishlistExpireDays: 7,
    resultPromptHour: 20,
    channelFactor: {
      referral: 3,
      official: 2,
      boss: 1,
      shixiseng: 1,
      nowcoder: 1,
      other: 1
    },
    weeklyApplyGoal: 8,
    courseSlots: [],
    defaultResumeVersion: ""
  };
}
function emptyDB() {
  return {
    settings: defaultSettings(),
    companies: [],
    applications: [],
    interviews: [],
    notes: []
  };
}
function loadDB() {
  if (typeof localStorage === "undefined") {
    return { db: emptyDB(), error: "\u5F53\u524D\u6D4F\u89C8\u5668\u4E0D\u652F\u6301\u672C\u5730\u5B58\u50A8\uFF0C\u6570\u636E\u4E0D\u4F1A\u88AB\u4FDD\u5B58\u3002" };
  }
  let raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return { db: emptyDB(), error: "\u6D4F\u89C8\u5668\u7981\u6B62\u4E86\u672C\u5730\u5B58\u50A8\uFF0C\u6570\u636E\u65E0\u6CD5\u4FDD\u5B58\u3002\u8BF7\u68C0\u67E5\u9690\u79C1\u8BBE\u7F6E\u3002" };
  }
  if (!raw) return { db: emptyDB(), error: null };
  try {
    const parsed = JSON.parse(raw);
    const result = validateImport(parsed);
    if (!result.ok) {
      return { db: emptyDB(), error: `\u6570\u636E\u5DF2\u635F\u574F\uFF08${result.error}\uFF09\uFF0C\u53EF\u5BFC\u51FA\u4FEE\u590D\u3002\u5DF2\u4E34\u65F6\u964D\u7EA7\u4E3A\u7A7A\u6570\u636E\u3002` };
    }
    return { db: result.db, error: null };
  } catch {
    return { db: emptyDB(), error: "\u6570\u636E\u5DF2\u635F\u574F\uFF08\u4E0D\u662F\u5408\u6CD5\u7684 JSON\uFF09\uFF0C\u53EF\u5BFC\u51FA\u4FEE\u590D\u3002\u5DF2\u4E34\u65F6\u964D\u7EA7\u4E3A\u7A7A\u6570\u636E\u3002" };
  }
}
function saveDB(db) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : "\u672A\u77E5\u9519\u8BEF";
    return `\u4FDD\u5B58\u5931\u8D25\uFF08${message}\uFF09\u3002\u53EF\u80FD\u662F\u6D4F\u89C8\u5668\u5B58\u50A8\u7A7A\u95F4\u4E0D\u8DB3\u6216\u88AB\u7981\u7528\u3002`;
  }
}
function exportJSON(db) {
  const payload = {
    exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
    app: "jobdesk",
    version: 1,
    settings: db.settings,
    companies: db.companies,
    applications: db.applications,
    interviews: db.interviews,
    notes: db.notes
  };
  return JSON.stringify(payload, null, 2);
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asString(value) {
  return typeof value === "string" ? value : "";
}
function asOptionalString(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function validateImport(raw) {
  if (!isRecord(raw)) return { ok: false, error: "\u9876\u5C42\u4E0D\u662F\u4E00\u4E2A\u5BF9\u8C61" };
  if (!("settings" in raw) && !("applications" in raw)) {
    return { ok: false, error: "\u7F3A\u5C11 settings / applications \u5B57\u6BB5\uFF0C\u8FD9\u4E0D\u50CF\u662F\u672C\u5E94\u7528\u5BFC\u51FA\u7684\u5907\u4EFD" };
  }
  const rawSettings = isRecord(raw.settings) ? raw.settings : {};
  const version = rawSettings.schemaVersion ?? raw.schemaVersion;
  if (version !== void 0 && Number(version) !== 1) {
    return { ok: false, error: `schemaVersion \u53EA\u652F\u6301 1\uFF0C\u6536\u5230\u7684\u662F ${String(version)}` };
  }
  const arrays = [
    "companies",
    "applications",
    "interviews",
    "notes"
  ];
  for (const key of arrays) {
    const value = raw[key];
    if (value === void 0) continue;
    if (!Array.isArray(value)) return { ok: false, error: `\u5B57\u6BB5 ${key} \u5FC5\u987B\u662F\u6570\u7EC4` };
  }
  const rawCompanies = Array.isArray(raw.companies) ? raw.companies : [];
  const rawApplications = Array.isArray(raw.applications) ? raw.applications : [];
  const rawInterviews = Array.isArray(raw.interviews) ? raw.interviews : [];
  const rawNotes = Array.isArray(raw.notes) ? raw.notes : [];
  const companies = [];
  for (let i = 0; i < rawCompanies.length; i += 1) {
    const item = rawCompanies[i];
    if (!isRecord(item)) return { ok: false, error: `\u7B2C ${i + 1} \u4E2A\u516C\u53F8\u4E0D\u662F\u5BF9\u8C61` };
    const id = asString(item.id);
    const name = asString(item.name);
    if (!id) return { ok: false, error: `\u7B2C ${i + 1} \u4E2A\u516C\u53F8\u7F3A\u5C11 id` };
    if (!name) return { ok: false, error: `\u7B2C ${i + 1} \u4E2A\u516C\u53F8\u7F3A\u5C11 name` };
    companies.push({
      id,
      name,
      shortName: asOptionalString(item.shortName),
      industry: asOptionalString(item.industry),
      city: asOptionalString(item.city),
      referrer: asOptionalString(item.referrer),
      impression: asOptionalString(item.impression),
      createdAt: asString(item.createdAt) || (/* @__PURE__ */ new Date()).toISOString()
    });
  }
  const applications = [];
  for (let i = 0; i < rawApplications.length; i += 1) {
    const item = rawApplications[i];
    if (!isRecord(item)) return { ok: false, error: `\u7B2C ${i + 1} \u6761\u6295\u9012\u4E0D\u662F\u5BF9\u8C61` };
    const id = asString(item.id);
    const companyId = asString(item.companyId);
    const jobTitle = asString(item.jobTitle);
    const status = asString(item.status);
    if (!id) return { ok: false, error: `\u7B2C ${i + 1} \u6761\u6295\u9012\u7F3A\u5C11 id` };
    if (!companyId) return { ok: false, error: `\u7B2C ${i + 1} \u6761\u6295\u9012\u7F3A\u5C11 companyId` };
    if (!jobTitle) return { ok: false, error: `\u7B2C ${i + 1} \u6761\u6295\u9012\u7F3A\u5C11 jobTitle` };
    if (!ALL_STATUSES.includes(status)) {
      return { ok: false, error: `\u7B2C ${i + 1} \u6761\u6295\u9012\u7684 status\u300C${asString(item.status)}\u300D\u4E0D\u5408\u6CD5` };
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    applications.push({
      id,
      companyId,
      jobTitle,
      jobType: item.jobType === "summer" || item.jobType === "fulltime" || item.jobType === "daily" ? item.jobType : "daily",
      city: asOptionalString(item.city),
      channel: asOptionalString(item.channel),
      appliedAt: asOptionalString(item.appliedAt),
      status,
      statusChangedAt: asString(item.statusChangedAt) || now,
      lastActivityAt: asString(item.lastActivityAt) || asString(item.statusChangedAt) || now,
      jdUrl: asOptionalString(item.jdUrl),
      resumeVersion: asOptionalString(item.resumeVersion),
      salaryText: asOptionalString(item.salaryText),
      daysPerWeek: typeof item.daysPerWeek === "number" ? item.daysPerWeek : void 0,
      durationMonths: typeof item.durationMonths === "number" ? item.durationMonths : void 0,
      silenceOverride: typeof item.silenceOverride === "number" ? item.silenceOverride : null,
      rejectedAtRound: typeof item.rejectedAtRound === "number" ? item.rejectedAtRound : null,
      rejectReason: asOptionalString(item.rejectReason),
      nextActionAt: asOptionalString(item.nextActionAt) || null,
      priority: item.priority === 1 || item.priority === 2 || item.priority === 3 ? item.priority : void 0,
      tags: Array.isArray(item.tags) ? item.tags.filter((t) => typeof t === "string") : [],
      createdAt: asString(item.createdAt) || now,
      updatedAt: asString(item.updatedAt) || now
    });
  }
  const interviews = [];
  for (let i = 0; i < rawInterviews.length; i += 1) {
    const item = rawInterviews[i];
    if (!isRecord(item)) return { ok: false, error: `\u7B2C ${i + 1} \u573A\u9762\u8BD5\u4E0D\u662F\u5BF9\u8C61` };
    const id = asString(item.id);
    const applicationId = asString(item.applicationId);
    const scheduledAt = asString(item.scheduledAt);
    const format = asString(item.format);
    const result = asString(item.result);
    if (!id) return { ok: false, error: `\u7B2C ${i + 1} \u573A\u9762\u8BD5\u7F3A\u5C11 id` };
    if (!applicationId) return { ok: false, error: `\u7B2C ${i + 1} \u573A\u9762\u8BD5\u7F3A\u5C11 applicationId` };
    if (!scheduledAt) return { ok: false, error: `\u7B2C ${i + 1} \u573A\u9762\u8BD5\u7F3A\u5C11 scheduledAt` };
    if (format !== "onsite" && format !== "video" && format !== "phone") {
      return { ok: false, error: `\u7B2C ${i + 1} \u573A\u9762\u8BD5\u7684 format \u4E0D\u5408\u6CD5` };
    }
    if (result !== "pending" && result !== "passed" && result !== "failed" && result !== "cancelled") {
      return { ok: false, error: `\u7B2C ${i + 1} \u573A\u9762\u8BD5\u7684 result \u4E0D\u5408\u6CD5` };
    }
    const checklist = Array.isArray(item.prepChecklist) ? item.prepChecklist.filter(isRecord).map((point, index) => ({
      id: asString(point.id) || `p_${index}`,
      text: asString(point.text),
      done: point.done === true
    })) : [];
    interviews.push({
      id,
      applicationId,
      round: typeof item.round === "number" && item.round > 0 ? item.round : 1,
      totalRounds: typeof item.totalRounds === "number" ? item.totalRounds : null,
      scheduledAt,
      durationMin: typeof item.durationMin === "number" ? item.durationMin : void 0,
      format,
      locationOrLink: asOptionalString(item.locationOrLink),
      interviewer: asOptionalString(item.interviewer),
      prepChecklist: checklist,
      result,
      notes: asOptionalString(item.notes)
    });
  }
  const notes = [];
  const allowedNoteTypes = ["chat", "interview", "followup", "system", "memo"];
  for (let i = 0; i < rawNotes.length; i += 1) {
    const item = rawNotes[i];
    if (!isRecord(item)) return { ok: false, error: `\u7B2C ${i + 1} \u6761\u65F6\u95F4\u7EBF\u4E0D\u662F\u5BF9\u8C61` };
    const id = asString(item.id);
    const applicationId = asString(item.applicationId);
    const touchedAt = asString(item.touchedAt);
    const type = asString(item.type);
    if (!id) return { ok: false, error: `\u7B2C ${i + 1} \u6761\u65F6\u95F4\u7EBF\u7F3A\u5C11 id` };
    if (!applicationId) return { ok: false, error: `\u7B2C ${i + 1} \u6761\u65F6\u95F4\u7EBF\u7F3A\u5C11 applicationId` };
    if (!touchedAt) return { ok: false, error: `\u7B2C ${i + 1} \u6761\u65F6\u95F4\u7EBF\u7F3A\u5C11 touchedAt` };
    if (!allowedNoteTypes.includes(type)) {
      return { ok: false, error: `\u7B2C ${i + 1} \u6761\u65F6\u95F4\u7EBF\u7684 type \u4E0D\u5408\u6CD5` };
    }
    notes.push({
      id,
      applicationId,
      type,
      content: asString(item.content),
      auto: item.auto === true,
      touchedAt
    });
  }
  const companyIds = new Set(companies.map((c) => c.id));
  for (const app of applications) {
    if (!companyIds.has(app.companyId)) {
      return { ok: false, error: `\u6295\u9012\u300C${app.jobTitle}\u300D\u5F15\u7528\u4E86\u4E0D\u5B58\u5728\u7684\u516C\u53F8\uFF08${app.companyId}\uFF09` };
    }
  }
  const appIds = new Set(applications.map((a) => a.id));
  for (const interview of interviews) {
    if (!appIds.has(interview.applicationId)) {
      return { ok: false, error: `\u9762\u8BD5\u8BB0\u5F55\uFF08\u7B2C ${interview.round} \u8F6E\uFF09\u5F15\u7528\u4E86\u4E0D\u5B58\u5728\u7684\u6295\u9012` };
    }
  }
  for (const note of notes) {
    if (!appIds.has(note.applicationId)) {
      return { ok: false, error: "\u65F6\u95F4\u7EBF\u6761\u76EE\u5F15\u7528\u4E86\u4E0D\u5B58\u5728\u7684\u6295\u9012" };
    }
  }
  const defaults = defaultSettings();
  const channelFactor = { ...defaults.channelFactor };
  if (isRecord(rawSettings.channelFactor)) {
    for (const key of Object.keys(channelFactor)) {
      const value = rawSettings.channelFactor[key];
      if (typeof value === "number" && value > 0) channelFactor[key] = value;
    }
  }
  const courseSlots = Array.isArray(rawSettings.courseSlots) ? rawSettings.courseSlots.filter(isRecord).map((slot) => ({
    weekday: typeof slot.weekday === "number" && slot.weekday >= 1 && slot.weekday <= 7 ? slot.weekday : 1,
    start: asString(slot.start) || "00:00",
    end: asString(slot.end) || "00:00",
    name: asString(slot.name)
  })) : [];
  const num = (value, fallback) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
  const hour = (value, fallback) => typeof value === "number" && Number.isFinite(value) ? Math.min(23, Math.max(0, Math.round(value))) : fallback;
  const settings = {
    schemaVersion: 1,
    warnAfterDays: num(rawSettings.warnAfterDays, defaults.warnAfterDays),
    staleAfterDays: num(rawSettings.staleAfterDays, defaults.staleAfterDays),
    interviewResultWaitDays: num(rawSettings.interviewResultWaitDays, defaults.interviewResultWaitDays),
    wishlistExpireDays: num(rawSettings.wishlistExpireDays, defaults.wishlistExpireDays),
    // 老备份里没有这个字段 → 补默认 20 点；不升 schemaVersion，保证旧数据仍可导入
    resultPromptHour: hour(rawSettings.resultPromptHour, defaults.resultPromptHour),
    channelFactor,
    weeklyApplyGoal: num(rawSettings.weeklyApplyGoal, defaults.weeklyApplyGoal),
    courseSlots,
    defaultResumeVersion: asOptionalString(rawSettings.defaultResumeVersion) ?? ""
  };
  return { ok: true, db: { settings, companies, applications, interviews, notes } };
}
function importFromText(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "\u6587\u4EF6\u5185\u5BB9\u4E0D\u662F\u5408\u6CD5\u7684 JSON\uFF0C\u8BF7\u786E\u8BA4\u9009\u5BF9\u4E86\u5907\u4EFD\u6587\u4EF6" };
  }
  return validateImport(parsed);
}

// app/src/lib/sample.ts
function at(now, daysAgo, hour = 10, min = 0) {
  const d = new Date(now.getTime());
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, min, 0, 0);
  return d;
}
function nextWeekday(now, weekday, minAhead) {
  const d = new Date(now.getTime());
  for (let i = minAhead; i < minAhead + 14; i += 1) {
    const candidate = new Date(now.getTime());
    candidate.setDate(candidate.getDate() + i);
    if (weekdayOf(candidate) === weekday) return candidate;
  }
  return d;
}
function todayAt(now, hour, min = 0) {
  const d = new Date(now.getTime());
  d.setHours(hour, min, 0, 0);
  return d;
}
function buildSampleDB(now = /* @__PURE__ */ new Date()) {
  const iso = (d) => d.toISOString();
  const companies = [
    {
      id: "c_bytedance",
      name: "\u5B57\u8282\u8DF3\u52A8",
      shortName: "\u5B57\u8282",
      industry: "\u4E92\u8054\u7F51",
      city: "\u5317\u4EAC",
      impression: "\u9762\u8BD5\u8282\u594F\u5FEB\uFF0C\u504F\u9879\u76EE\u6DF1\u6316 + \u624B\u5199\u4EE3\u7801",
      createdAt: iso(at(now, 12))
    },
    {
      id: "c_meituan",
      name: "\u7F8E\u56E2",
      shortName: "\u7F8E\u56E2",
      industry: "\u672C\u5730\u751F\u6D3B",
      city: "\u5317\u4EAC",
      createdAt: iso(at(now, 10))
    },
    {
      id: "c_xiaohongshu",
      name: "\u5C0F\u7EA2\u4E66",
      shortName: "\u5C0F\u7EA2\u4E66",
      industry: "\u5185\u5BB9\u793E\u533A",
      city: "\u4E0A\u6D77",
      createdAt: iso(at(now, 4))
    },
    {
      id: "c_tencent",
      name: "\u817E\u8BAF",
      shortName: "\u817E\u8BAF",
      industry: "\u4E92\u8054\u7F51",
      city: "\u6DF1\u5733",
      referrer: "\u5B66\u957F\u5F20",
      impression: "PCG \u504F\u57FA\u7840\u529F\u5E95\uFF0C\u95EE\u5F97\u7EC6",
      createdAt: iso(at(now, 14))
    },
    {
      id: "c_alibaba",
      name: "\u963F\u91CC\u5DF4\u5DF4",
      shortName: "\u963F\u91CC",
      industry: "\u7535\u5546",
      city: "\u676D\u5DDE",
      createdAt: iso(at(now, 18))
    },
    {
      id: "c_netease",
      name: "\u7F51\u6613",
      shortName: "\u7F51\u6613",
      industry: "\u6E38\u620F/\u5185\u5BB9",
      city: "\u676D\u5DDE",
      createdAt: iso(at(now, 9))
    },
    {
      id: "c_kuaishou",
      name: "\u5FEB\u624B",
      shortName: "\u5FEB\u624B",
      industry: "\u77ED\u89C6\u9891",
      city: "\u5317\u4EAC",
      createdAt: iso(at(now, 20))
    },
    {
      id: "c_huawei",
      name: "\u534E\u4E3A",
      shortName: "\u534E\u4E3A",
      industry: "\u901A\u4FE1/\u7EC8\u7AEF",
      city: "\u4E1C\u839E",
      createdAt: iso(at(now, 25))
    }
  ];
  const resumeVersion = "v3-\u524D\u7AEF-\u9879\u76EE\u7248";
  const roundTwoDay = nextWeekday(now, 4, 2);
  roundTwoDay.setHours(14, 30, 0, 0);
  const applications = [
    {
      id: "app_bytedance",
      companyId: "c_bytedance",
      jobTitle: "\u6296\u97F3\u524D\u7AEF\u5F00\u53D1\u5B9E\u4E60\u751F",
      jobType: "daily",
      city: "\u5317\u4EAC",
      channel: "boss",
      appliedAt: toDateISO(at(now, 12)),
      status: "chatting",
      statusChangedAt: iso(at(now, 12, 10, 12)),
      lastActivityAt: iso(at(now, 9, 16, 40)),
      jdUrl: "https://www.zhipin.com/job_detail/demo-bytedance.html",
      resumeVersion,
      salaryText: "250-300/\u5929",
      daysPerWeek: 3,
      durationMonths: 4,
      silenceOverride: null,
      rejectedAtRound: null,
      nextActionAt: null,
      priority: 3,
      tags: ["\u60F3\u53BB", "\u6709\u8F6C\u6B63"],
      createdAt: iso(at(now, 12, 10, 12)),
      updatedAt: iso(at(now, 9, 16, 40))
    },
    {
      id: "app_meituan",
      companyId: "c_meituan",
      jobTitle: "\u5230\u5E97\u4E8B\u4E1A\u7FA4 \u524D\u7AEF\u5B9E\u4E60\u751F",
      jobType: "daily",
      city: "\u5317\u4EAC",
      channel: "boss",
      appliedAt: toDateISO(at(now, 10)),
      status: "applied",
      statusChangedAt: iso(at(now, 10, 9, 30)),
      lastActivityAt: iso(at(now, 10, 9, 30)),
      resumeVersion,
      salaryText: "200-250/\u5929",
      daysPerWeek: 4,
      durationMonths: 3,
      silenceOverride: null,
      rejectedAtRound: null,
      nextActionAt: null,
      priority: 2,
      tags: ["\u5230\u5C974\u5929"],
      createdAt: iso(at(now, 10, 9, 30)),
      updatedAt: iso(at(now, 10, 9, 30))
    },
    {
      id: "app_xiaohongshu",
      companyId: "c_xiaohongshu",
      jobTitle: "\u524D\u7AEF\u5F00\u53D1\u5B9E\u4E60\u751F\uFF08\u793E\u533A\uFF09",
      jobType: "daily",
      city: "\u4E0A\u6D77",
      channel: "shixiseng",
      appliedAt: toDateISO(at(now, 4)),
      status: "applied",
      statusChangedAt: iso(at(now, 4, 11, 0)),
      lastActivityAt: iso(at(now, 4, 11, 0)),
      resumeVersion: "v2-\u524D\u7AEF-\u57FA\u7840\u7248",
      salaryText: "180-220/\u5929",
      daysPerWeek: 3,
      durationMonths: 4,
      silenceOverride: null,
      rejectedAtRound: null,
      nextActionAt: null,
      priority: 3,
      tags: [],
      createdAt: iso(at(now, 4, 11, 0)),
      updatedAt: iso(at(now, 4, 11, 0))
    },
    {
      id: "app_tencent",
      companyId: "c_tencent",
      jobTitle: "PCG \u524D\u7AEF\u5F00\u53D1\u5B9E\u4E60\u751F",
      jobType: "daily",
      city: "\u6DF1\u5733",
      channel: "referral",
      appliedAt: toDateISO(at(now, 14)),
      status: "scheduled",
      statusChangedAt: iso(at(now, 1, 20, 0)),
      lastActivityAt: iso(at(now, 1, 20, 0)),
      resumeVersion,
      salaryText: "300/\u5929",
      daysPerWeek: 3,
      durationMonths: 6,
      silenceOverride: null,
      rejectedAtRound: null,
      nextActionAt: toDateISO(now),
      priority: 3,
      tags: ["\u5185\u63A8", "\u60F3\u53BB"],
      createdAt: iso(at(now, 14, 9, 0)),
      updatedAt: iso(at(now, 1, 20, 0))
    },
    {
      id: "app_alibaba",
      companyId: "c_alibaba",
      jobTitle: "\u6DD8\u5929\u96C6\u56E2 \u524D\u7AEF\u5B9E\u4E60\u751F",
      jobType: "daily",
      city: "\u676D\u5DDE",
      channel: "official",
      appliedAt: toDateISO(at(now, 18)),
      status: "interviewing",
      statusChangedAt: iso(at(now, 6, 17, 0)),
      lastActivityAt: iso(at(now, 6, 17, 0)),
      resumeVersion: "v2-\u524D\u7AEF-\u57FA\u7840\u7248",
      salaryText: "250/\u5929",
      daysPerWeek: 4,
      durationMonths: 4,
      silenceOverride: null,
      rejectedAtRound: null,
      nextActionAt: null,
      priority: 2,
      tags: ["\u4E8C\u9762\u5DF2\u7EA6"],
      createdAt: iso(at(now, 18, 9, 0)),
      updatedAt: iso(at(now, 6, 17, 0))
    },
    {
      id: "app_netease",
      companyId: "c_netease",
      jobTitle: "\u524D\u7AEF\u5F00\u53D1\u5B9E\u4E60\u751F\uFF08\u6E38\u620F\u5DE5\u5177\uFF09",
      jobType: "daily",
      city: "\u676D\u5DDE",
      channel: "nowcoder",
      appliedAt: "",
      status: "wishlist",
      statusChangedAt: iso(at(now, 9, 22, 0)),
      lastActivityAt: iso(at(now, 9, 22, 0)),
      resumeVersion: "",
      salaryText: "200/\u5929",
      daysPerWeek: 3,
      durationMonths: 3,
      silenceOverride: null,
      rejectedAtRound: null,
      nextActionAt: null,
      priority: 1,
      tags: [],
      createdAt: iso(at(now, 9, 22, 0)),
      updatedAt: iso(at(now, 9, 22, 0))
    },
    {
      id: "app_kuaishou",
      companyId: "c_kuaishou",
      jobTitle: "\u5546\u4E1A\u5316 \u524D\u7AEF\u5B9E\u4E60\u751F",
      jobType: "daily",
      city: "\u5317\u4EAC",
      channel: "boss",
      appliedAt: toDateISO(at(now, 20)),
      status: "rejected",
      statusChangedAt: iso(at(now, 3, 15, 0)),
      lastActivityAt: iso(at(now, 3, 15, 0)),
      resumeVersion,
      salaryText: "220/\u5929",
      daysPerWeek: 3,
      durationMonths: 4,
      silenceOverride: null,
      rejectedAtRound: 2,
      rejectReason: "\u624B\u5199 Promise \u6CA1\u5199\u5B8C\u6574\uFF0CVite \u6253\u5305\u539F\u7406\u7B54\u5F97\u542B\u7CCA",
      nextActionAt: null,
      priority: 1,
      tags: [],
      createdAt: iso(at(now, 20, 21, 0)),
      updatedAt: iso(at(now, 3, 15, 0))
    },
    {
      id: "app_huawei",
      companyId: "c_huawei",
      jobTitle: "\u7EC8\u7AEF BG \u524D\u7AEF\u5F00\u53D1\u5B9E\u4E60\u751F",
      jobType: "daily",
      city: "\u4E1C\u839E",
      channel: "official",
      appliedAt: toDateISO(at(now, 25)),
      status: "offer",
      statusChangedAt: iso(at(now, 2, 18, 30)),
      lastActivityAt: iso(at(now, 2, 18, 30)),
      resumeVersion: "v3-\u524D\u7AEF-\u9879\u76EE\u7248",
      salaryText: "260/\u5929 + \u623F\u8865",
      daysPerWeek: 5,
      durationMonths: 6,
      silenceOverride: null,
      rejectedAtRound: null,
      nextActionAt: null,
      priority: 2,
      tags: ["\u5DF2\u53D1offer"],
      createdAt: iso(at(now, 25, 10, 0)),
      updatedAt: iso(at(now, 2, 18, 30))
    }
  ];
  const interviews = [
    {
      id: "iv_tencent_1",
      applicationId: "app_tencent",
      round: 1,
      totalRounds: 2,
      scheduledAt: iso(todayAt(now, 15, 0)),
      durationMin: 45,
      format: "video",
      locationOrLink: "\u817E\u8BAF\u4F1A\u8BAE 823-114-560",
      interviewer: "PCG \u524D\u7AEF leader",
      prepChecklist: [
        { id: "p1", text: "\u9879\u76EE\u96BE\u70B9\u8BB2\u6E05\u695A\uFF08\u6027\u80FD\u4F18\u5316\u90A3\u6761\uFF09", done: true },
        { id: "p2", text: "\u4E8B\u4EF6\u5FAA\u73AF + Promise \u624B\u5199", done: false },
        { id: "p3", text: "\u6D4F\u89C8\u5668\u7F13\u5B58\u7B56\u7565", done: false },
        { id: "p4", text: "\u53CD\u95EE 2 \u4E2A\u95EE\u9898", done: true }
      ],
      result: "pending",
      notes: ""
    },
    {
      id: "iv_alibaba_1",
      applicationId: "app_alibaba",
      round: 1,
      totalRounds: 2,
      scheduledAt: iso(at(now, 6, 14, 0)),
      durationMin: 60,
      format: "video",
      locationOrLink: "\u9489\u9489\u4F1A\u8BAE",
      interviewer: "\u6DD8\u5929 \u524D\u7AEF",
      prepChecklist: [{ id: "p1", text: "Vue \u54CD\u5E94\u5F0F\u539F\u7406", done: true }],
      result: "passed",
      notes: "\u95EE\u4E86 Vite \u6253\u5305\u539F\u7406\u3001\u6D4F\u89C8\u5668\u7F13\u5B58\uFF0C\u624B\u5199\u4E86\u9632\u6296\u3002\u8BF4\u4E00\u5468\u5185\u7ED9\u6D88\u606F\u3002"
    },
    {
      id: "iv_alibaba_2",
      applicationId: "app_alibaba",
      round: 2,
      totalRounds: 2,
      scheduledAt: iso(roundTwoDay),
      durationMin: 60,
      format: "onsite",
      locationOrLink: "\u676D\u5DDE\u897F\u6EAA\u56ED\u533A A \u5EA7",
      interviewer: "\u5F85\u5B9A",
      prepChecklist: [
        { id: "p1", text: "\u590D\u76D8\u4E00\u9762\u88AB\u95EE\u7684\u95EE\u9898", done: false },
        { id: "p2", text: "\u51C6\u5907\u4E00\u4E2A\u53CD\u95EE", done: false }
      ],
      result: "pending",
      notes: ""
    },
    {
      id: "iv_huawei_1",
      applicationId: "app_huawei",
      round: 1,
      totalRounds: 2,
      scheduledAt: iso(at(now, 9, 10, 0)),
      durationMin: 45,
      format: "phone",
      locationOrLink: "\u7535\u8BDD",
      interviewer: "\u7EC8\u7AEF HR",
      prepChecklist: [],
      result: "passed",
      notes: "\u4E3B\u8981\u804A\u4E86\u9879\u76EE\uFF0C\u5F88\u987A\u5229\u3002"
    },
    {
      id: "iv_huawei_2",
      applicationId: "app_huawei",
      round: 2,
      totalRounds: 2,
      scheduledAt: iso(at(now, 5, 16, 0)),
      durationMin: 50,
      format: "video",
      locationOrLink: "Welink",
      interviewer: "\u7EC8\u7AEF BG \u6280\u672F\u8D1F\u8D23\u4EBA",
      prepChecklist: [],
      result: "passed",
      notes: "\u95EE\u4E86\u5DE5\u7A0B\u5316\uFF0C\u804A\u5F97\u6BD4\u8F83\u5F00\u3002"
    },
    {
      id: "iv_kuaishou_1",
      applicationId: "app_kuaishou",
      round: 1,
      totalRounds: 2,
      scheduledAt: iso(at(now, 8, 15, 0)),
      durationMin: 45,
      format: "video",
      locationOrLink: "\u98DE\u4E66\u4F1A\u8BAE",
      interviewer: "\u5546\u4E1A\u5316 \u524D\u7AEF",
      prepChecklist: [],
      result: "passed",
      notes: ""
    },
    {
      id: "iv_kuaishou_2",
      applicationId: "app_kuaishou",
      round: 2,
      totalRounds: 2,
      scheduledAt: iso(at(now, 3, 14, 0)),
      durationMin: 45,
      format: "video",
      locationOrLink: "\u98DE\u4E66\u4F1A\u8BAE",
      interviewer: "\u5546\u4E1A\u5316 \u6280\u672F\u8D1F\u8D23\u4EBA",
      prepChecklist: [],
      result: "failed",
      notes: "\u624B\u5199 Promise \u6CA1\u5199\u5B8C\u6574\u3002"
    }
  ];
  const notes = [
    {
      id: "n_bytedance_1",
      applicationId: "app_bytedance",
      type: "chat",
      content: "BOSS \u4E0A\u6253\u62DB\u547C\uFF0C\u53D1\u4E86\u9879\u76EE\u94FE\u63A5\uFF0CHR \u95EE\u5230\u5C97\u65F6\u95F4\u3002",
      touchedAt: iso(at(now, 11, 14, 5))
    },
    {
      id: "n_bytedance_2",
      applicationId: "app_bytedance",
      type: "chat",
      content: "HR \u8BF4\u300C\u8FD9\u5468\u5185\u7ED9\u6D88\u606F\u300D\uFF0C\u4E4B\u540E\u5C31\u6CA1\u6709\u4E0B\u6587\u4E86\u3002",
      touchedAt: iso(at(now, 9, 16, 40))
    },
    {
      id: "n_meituan_1",
      applicationId: "app_meituan",
      type: "chat",
      content: "\u5B98\u7F51\u6295\u4E86\u4E00\u4EFD\u5230\u5E97\u524D\u7AEF\uFF0C\u6682\u65F6\u6CA1\u6709\u56DE\u97F3\u3002",
      touchedAt: iso(at(now, 10, 9, 30))
    },
    {
      id: "n_xiaohongshu_1",
      applicationId: "app_xiaohongshu",
      type: "memo",
      content: "\u5B9E\u4E60\u50E7\u4E0A\u6295\u7684\uFF0C\u5C97\u4F4D\u5199\u7740\u300C\u53EF\u8F6C\u6B63\u300D\u3002",
      touchedAt: iso(at(now, 4, 11, 0))
    },
    {
      id: "n_tencent_1",
      applicationId: "app_tencent",
      type: "system",
      content: "\u72B6\u6001\uFF1A\u5DF2\u6C9F\u901A \u2192 \u5DF2\u7EA6\u9762",
      auto: true,
      touchedAt: iso(at(now, 1, 20, 0))
    },
    {
      id: "n_tencent_2",
      applicationId: "app_tencent",
      type: "interview",
      content: "\u5B66\u957F\u5185\u63A8\u7684\uFF0C\u7EA6\u4E86\u4E00\u9762\uFF0C\u89C6\u9891\u9762 45 \u5206\u949F\u3002",
      touchedAt: iso(at(now, 1, 20, 1))
    },
    {
      id: "n_alibaba_1",
      applicationId: "app_alibaba",
      type: "interview",
      content: "\u4E00\u9762\u7ED3\u675F\uFF1A\u95EE\u4E86 Vite \u6253\u5305\u539F\u7406\u548C\u6D4F\u89C8\u5668\u7F13\u5B58\uFF0C\u624B\u5199\u4E86\u9632\u6296\u3002\u611F\u89C9\u8FD8\u884C\uFF0C\u8BF4\u4E00\u5468\u5185\u7ED9\u6D88\u606F\u3002",
      touchedAt: iso(at(now, 6, 17, 0))
    },
    {
      id: "n_huawei_1",
      applicationId: "app_huawei",
      type: "system",
      content: "\u72B6\u6001\uFF1A\u9762\u8BD5\u4E2D \u2192 \u5DF2\u53D1 Offer",
      auto: true,
      touchedAt: iso(at(now, 2, 18, 30))
    },
    {
      id: "n_huawei_2",
      applicationId: "app_huawei",
      type: "memo",
      content: "\u53E3\u5934 offer \u5230\u624B\uFF0C\u9700\u8981\u786E\u8BA4\u5230\u5C97\u65E5\u671F\u548C\u6BCF\u5468\u5929\u6570\uFF085 \u5929\u6709\u70B9\u591A\uFF09\u3002",
      touchedAt: iso(at(now, 2, 18, 32))
    },
    {
      id: "n_kuaishou_1",
      applicationId: "app_kuaishou",
      type: "system",
      content: "\u72B6\u6001\uFF1A\u9762\u8BD5\u4E2D \u2192 \u5DF2\u6302",
      auto: true,
      touchedAt: iso(at(now, 3, 15, 0))
    },
    {
      id: "n_kuaishou_2",
      applicationId: "app_kuaishou",
      type: "memo",
      content: "\u4E8C\u9762\u6302\u5728\u624B\u5199 Promise \u548C Vite \u6253\u5305\u539F\u7406\uFF0C\u4E0B\u6B21\u5148\u628A\u8FD9\u4E24\u5757\u8865\u4E0A\u3002",
      touchedAt: iso(at(now, 3, 15, 5))
    }
  ];
  const settings = defaultSettings();
  settings.courseSlots = [
    { weekday: 2, start: "08:00", end: "09:40", name: "\u6570\u636E\u7ED3\u6784" },
    { weekday: 4, start: "14:00", end: "15:40", name: "\u8BA1\u7B97\u673A\u7F51\u7EDC" }
  ];
  settings.defaultResumeVersion = resumeVersion;
  return { settings, companies, applications, interviews, notes };
}

// qa-run/algo2.test.ts
var pass = 0;
var fail = 0;
var rows = [];
function eq(name, actual, expected, note = "") {
  const ok2 = JSON.stringify(actual) === JSON.stringify(expected);
  rows.push({ name, expect: JSON.stringify(expected), actual: JSON.stringify(actual) + (note ? ` (${note})` : ""), ok: ok2 });
  if (ok2) pass += 1;
  else fail += 1;
}
function ok(name, cond, detail = "") {
  rows.push({ name, expect: "true", actual: String(cond) + (detail ? ` (${detail})` : ""), ok: cond });
  if (cond) pass += 1;
  else fail += 1;
}
var NOW = new Date(2025, 2, 12, 9, 0, 0, 0);
var SETTINGS = defaultSettings();
function daysAgoAtMidnight(n) {
  return new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - n, 0, 0, 0, 0).toISOString();
}
function mkApp(over = {}) {
  return {
    id: "app_x",
    companyId: "c_x",
    jobTitle: "\u524D\u7AEF\u5B9E\u4E60\u751F",
    status: "applied",
    channel: "boss",
    appliedAt: "2025-03-01",
    statusChangedAt: NOW.toISOString(),
    lastActivityAt: NOW.toISOString(),
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    silenceOverride: null,
    ...over
  };
}
function mkSilentApp(days, over = {}) {
  const at2 = daysAgoAtMidnight(days);
  return mkApp({ statusChangedAt: at2, createdAt: at2, lastActivityAt: at2, ...over });
}
function levelOf(app, notes = [], settings = SETTINGS) {
  return silenceStateOf(app, notes, settings, NOW).level;
}
{
  const d = parseFlexible("2025-03-05");
  eq("R1.1 \u7EAF\u65E5\u671F\u6309\u672C\u5730\u96F6\u70B9\u89E3\u6790", [d.getHours(), d.getDate()], [0, 5]);
  eq("R1.2 daysBetween 3/05\u21923/08", daysBetween("2025-03-05", "2025-03-08"), 3);
  eq("R1.3 23:59\u2192\u6B21\u65E5 00:00 \u8BB0 1 \u5929", daysBetween(new Date(2025, 2, 5, 23, 59), new Date(2025, 2, 6, 0, 0)), 1);
  ok("R1.4 startOfDay \u5F52\u96F6", startOfDay(new Date(2025, 2, 5, 18, 30)).getHours() === 0);
  ok("R1.5 isSameDay", isSameDay(new Date(2025, 2, 5, 0, 1), new Date(2025, 2, 5, 23, 59)));
}
{
  eq("R2.1 \u4ECA\u5929 00:00 \u2192 null", levelOf(mkSilentApp(0)), null);
  eq("R2.2 \u6628\u5929 23:59 \u2192 null", levelOf(mkApp({ statusChangedAt: new Date(2025, 2, 11, 23, 59).toISOString() })), null);
  eq("R2.3 \u7B2C 2 \u5929 \u2192 null", levelOf(mkSilentApp(2)), null);
  eq("R2.4 \u6070\u597D\u7B2C 3 \u5929 \u2192 warn", levelOf(mkSilentApp(3)), "warn");
  eq("R2.5 \u7B2C 6 \u5929 \u2192 warn", levelOf(mkSilentApp(6)), "warn");
  eq("R2.6 \u6070\u597D\u7B2C 7 \u5929 \u2192 stale", levelOf(mkSilentApp(7)), "stale");
  eq("R2.7 \u7B2C 30 \u5929 \u2192 stale", levelOf(mkSilentApp(30)), "stale");
  eq("R2.8 stale \u6587\u6848", silenceStateOf(mkSilentApp(7), [], SETTINGS, NOW).text, "\u5DF2\u6C89\u9ED8 7 \u5929");
  eq("R2.9 silenceDays", silenceDaysOf(mkSilentApp(4), [], NOW), 4);
  eq("R2.10 \u672A\u6765\u65F6\u95F4\u4E0D\u51FA\u73B0\u8D1F\u5929\u6570", silenceDaysOf(mkApp({ statusChangedAt: new Date(2025, 2, 20).toISOString() }), [], NOW), 0);
}
{
  eq("R3.1 referral \u7CFB\u6570 3", channelFactorOf(mkApp({ channel: "referral" }), SETTINGS), 3);
  eq("R3.2 official \u7CFB\u6570 2", channelFactorOf(mkApp({ channel: "official" }), SETTINGS), 2);
  eq("R3.3 \u672A\u586B\u6E20\u9053\u515C\u5E95 1", channelFactorOf(mkApp({ channel: void 0 }), SETTINGS), 1);
  eq("R3.4 referral warn/stale \u9608\u503C", [effectiveWarnDays(mkApp({ channel: "referral" }), SETTINGS), effectiveStaleDays(mkApp({ channel: "referral" }), SETTINGS)], [9, 21]);
  eq("R3.5 official warn/stale \u9608\u503C", [effectiveWarnDays(mkApp({ channel: "official" }), SETTINGS), effectiveStaleDays(mkApp({ channel: "official" }), SETTINGS)], [6, 14]);
  eq("R3.6 boss stale \u9608\u503C 7", effectiveStaleDays(mkApp({ channel: "boss" }), SETTINGS), 7);
  eq("R3.7 referral \u6C89\u9ED8 8 \u5929 \u2192 null\uFF08\u9EC4\u9608\u503C 9\uFF09", levelOf(mkSilentApp(8, { channel: "referral" })), null);
  eq("R3.8 referral \u6C89\u9ED8 9 \u5929 \u2192 warn", levelOf(mkSilentApp(9, { channel: "referral" })), "warn");
  eq("R3.9 referral \u6C89\u9ED8 21 \u5929 \u2192 stale", levelOf(mkSilentApp(21, { channel: "referral" })), "stale");
  eq("R3.10 official \u6C89\u9ED8 6 \u5929 \u2192 warn", levelOf(mkSilentApp(6, { channel: "official" })), "warn");
  eq("R3.11 official \u6C89\u9ED8 12 \u5929 \u2192 warn\uFF08\u7EA2\u9608\u503C 14\uFF09", levelOf(mkSilentApp(12, { channel: "official" })), "warn");
  eq("R3.12 official \u6C89\u9ED8 14 \u5929 \u2192 stale", levelOf(mkSilentApp(14, { channel: "official" })), "stale");
}
{
  eq("R4.1 override=10\uFF08boss\uFF09stale \u9608\u503C = 10", effectiveStaleDays(mkApp({ silenceOverride: 10, channel: "boss" }), SETTINGS), 10);
  eq("R4.2 override=10\uFF08referral\uFF09stale \u9608\u503C\u4ECD = 10\uFF08\u4E0D\u518D \xD73\uFF09", effectiveStaleDays(mkApp({ silenceOverride: 10, channel: "referral" }), SETTINGS), 10);
  eq("R4.3 override=10\uFF08official\uFF09stale \u9608\u503C\u4ECD = 10", effectiveStaleDays(mkApp({ silenceOverride: 10, channel: "official" }), SETTINGS), 10);
  eq("R4.4 override=10 \u2192 warn = min(3, 5) = 3", effectiveWarnDays(mkApp({ silenceOverride: 10 }), SETTINGS), 3);
  eq("R4.5 override=6 \u2192 warn = 3", effectiveWarnDays(mkApp({ silenceOverride: 6 }), SETTINGS), 3);
  eq("R4.6 override=2 \u2192 warn = 1", effectiveWarnDays(mkApp({ silenceOverride: 2 }), SETTINGS), 1);
  eq("R4.7 override=2 \u2192 stale = 2", effectiveStaleDays(mkApp({ silenceOverride: 2 }), SETTINGS), 2);
  eq("R4.8 override=10 + \u5185\u63A8\uFF0C\u6C89\u9ED8 12 \u5929 \u2192 stale", levelOf(mkSilentApp(12, { silenceOverride: 10, channel: "referral" })), "stale");
  eq("R4.9 override=10 + \u5185\u63A8\uFF0C\u6C89\u9ED8 9 \u5929 \u2192 warn", levelOf(mkSilentApp(9, { silenceOverride: 10, channel: "referral" })), "warn");
  eq("R4.10 override=10\uFF0C\u6C89\u9ED8 10 \u5929 \u2192 stale\uFF08\u5F53\u5929\u5373\u7EA2\uFF09", levelOf(mkSilentApp(10, { silenceOverride: 10 })), "stale");
  eq("R4.11 override=6\uFF0C\u6C89\u9ED8 3 \u5929 \u2192 warn", levelOf(mkSilentApp(3, { silenceOverride: 6 })), "warn");
  eq("R4.12 override=2\uFF0C\u6C89\u9ED8 1 \u5929 \u2192 warn", levelOf(mkSilentApp(1, { silenceOverride: 2 })), "warn");
  eq("R4.13 override=2\uFF0C\u6C89\u9ED8 2 \u5929 \u2192 stale", levelOf(mkSilentApp(2, { silenceOverride: 2 })), "stale");
  eq("R4.14 override=1 \u2192 warn \u9608\u503C 1", effectiveWarnDays(mkApp({ silenceOverride: 1 }), SETTINGS), 1);
  eq("R4.15 override=1 \u2192 stale \u9608\u503C 1", effectiveStaleDays(mkApp({ silenceOverride: 1 }), SETTINGS), 1);
  eq("R4.16 override=1\uFF0C\u6C89\u9ED8 1 \u5929 \u2192 stale\uFF08\u5148\u5224\u7EA2\uFF0C\u9EC4\u770B\u4E0D\u5230\u4E86\uFF09", levelOf(mkSilentApp(1, { silenceOverride: 1 })), "stale");
  eq("R4.17 override=null \u7684\u5185\u63A8\u4ECD\u6309 21 \u5929", effectiveStaleDays(mkApp({ silenceOverride: null, channel: "referral" }), SETTINGS), 21);
  eq("R4.18 override=undefined \u7684\u5B98\u7F51\u4ECD\u6309 14 \u5929", effectiveStaleDays(mkApp({ channel: "official" }), SETTINGS), 14);
  const s5 = { ...defaultSettings(), warnAfterDays: 5 };
  eq("R4.19 warnAfterDays=5 \u65F6 override=10 \u2192 warn=min(5,5)=5", effectiveWarnDays(mkApp({ silenceOverride: 10 }), s5), 5);
  eq("R4.20 warnAfterDays=5 \u65F6 override=4 \u2192 warn=min(5,2)=2", effectiveWarnDays(mkApp({ silenceOverride: 4 }), s5), 2);
}
{
  eq("R5.1 interviewing \u6C89\u9ED8 5 \u5929 \u2192 stale", levelOf(mkSilentApp(5, { status: "interviewing" })), "stale");
  eq("R5.2 interviewing \u6C89\u9ED8 4 \u5929 \u2192 warn", levelOf(mkSilentApp(4, { status: "interviewing" })), "warn");
  eq("R5.3 interviewing \u6587\u6848\u4E3A\u300C\u7B49\u7ED3\u679C\u300D", silenceStateOf(mkSilentApp(6, { status: "interviewing" }), [], SETTINGS, NOW).text, "\u7B49\u7ED3\u679C 6 \u5929");
  eq("R5.4 interviewing + official \u6C89\u9ED8 10 \u5929 \u2192 stale\uFF085\xD72\uFF09", levelOf(mkSilentApp(10, { status: "interviewing", channel: "official" })), "stale");
  eq("R5.5 wishlist 8/7/6 \u5929\u8D85\u671F", [
    wishlistExpiredDays(mkApp({ status: "wishlist", createdAt: daysAgoAtMidnight(8) }), SETTINGS, NOW),
    wishlistExpiredDays(mkApp({ status: "wishlist", createdAt: daysAgoAtMidnight(7) }), SETTINGS, NOW),
    wishlistExpiredDays(mkApp({ status: "wishlist", createdAt: daysAgoAtMidnight(6) }), SETTINGS, NOW)
  ], [8, 7, null]);
  eq("R5.6 wishlist \u4E0D\u53C2\u4E0E silence", levelOf(mkSilentApp(30, { status: "wishlist" })), null);
  eq("R5.7 scheduled \u4E0D\u53C2\u4E0E silence", levelOf(mkSilentApp(30, { status: "scheduled" })), null);
  ["onboarded", "rejected", "dropped", "offer"].forEach((status, i) => {
    eq(`R5.${8 + i} ${status} \u6C89\u9ED8 30 \u5929 \u2192 null`, levelOf(mkSilentApp(30, { status })), null);
  });
}
{
  const app = mkApp({ statusChangedAt: daysAgoAtMidnight(10) });
  eq("R6.1 \u65E0 note \u65F6\u7528 statusChangedAt", lastActivityAtOf(app, []), app.statusChangedAt);
  const notes = [
    { id: "n1", applicationId: "app_x", type: "chat", content: "\u804A\u4E86", touchedAt: daysAgoAtMidnight(6) },
    { id: "n2", applicationId: "app_x", type: "memo", content: "\u5907\u6CE8", touchedAt: daysAgoAtMidnight(2) },
    { id: "n_other", applicationId: "app_OTHER", type: "chat", content: "\u522B\u4EBA\u7684", touchedAt: daysAgoAtMidnight(0) }
  ];
  eq("R6.2 \u53D6 note \u6700\u5927\u503C\u4E14\u5FFD\u7565\u4ED6\u4EBA note", lastActivityAtOf(app, notes), notes[1].touchedAt);
  eq("R6.3 \u7EA2\u5361\u524D\u7F6E\uFF1A9 \u5929 \u2192 stale", levelOf(mkSilentApp(9)), "stale");
  eq("R6.4 \u65B0\u589E now \u7684 note \u2192 \u7ACB\u523B null", levelOf(mkSilentApp(9), [{ id: "nn", applicationId: "app_x", type: "followup", content: "\u50AC\u4E86", touchedAt: NOW.toISOString() }]), null);
}
{
  const base = buildSampleDB(NOW);
  const before = JSON.parse(JSON.stringify(base));
  const meituanBefore = base.applications.find((a) => a.id === "app_meituan");
  const undo = {
    appId: "app_meituan",
    prevStatus: meituanBefore.status,
    prevStatusChangedAt: meituanBefore.statusChangedAt,
    prevLastActivityAt: meituanBefore.lastActivityAt,
    prevRejectedAtRound: meituanBefore.rejectedAtRound ?? null,
    createdNoteId: "n_sys_new"
  };
  const draft = JSON.parse(JSON.stringify(base));
  const target = draft.applications.find((a) => a.id === "app_meituan");
  target.status = "chatting";
  target.statusChangedAt = NOW.toISOString();
  target.lastActivityAt = NOW.toISOString();
  draft.notes.push({ id: "n_sys_new", applicationId: "app_meituan", type: "system", content: statusChangeText("applied", "chatting"), auto: true, touchedAt: NOW.toISOString() });
  draft.notes.push({ id: "n_user_new", applicationId: "app_meituan", type: "memo", content: "HR \u8BF4\u4E0B\u5468\u4E00\u9762", auto: false, touchedAt: new Date(2025, 2, 12, 9, 30).toISOString() });
  eq("R7.1 \u53D8\u66F4\u540E\u72B6\u6001\u4E3A chatting", draft.applications.find((a) => a.id === "app_meituan").status, "chatting");
  eq("R7.2 \u53D8\u66F4\u540E note \u6570 = \u539F\u59CB +2", draft.notes.length, before.notes.length + 2);
  revertStatusChange(draft, undo);
  const after = draft.applications.find((a) => a.id === "app_meituan");
  eq("R7.3 \u64A4\u9500\u540E\u72B6\u6001\u56DE\u5230 applied", after.status, "applied");
  eq("R7.4 \u64A4\u9500\u540E statusChangedAt \u590D\u539F", after.statusChangedAt, undo.prevStatusChangedAt);
  eq("R7.5 \u64A4\u9500\u540E\u90A3\u6761 system \u8BB0\u5F55\u88AB\u7CBE\u786E\u5220\u9664", draft.notes.some((n) => n.id === "n_sys_new"), false);
  eq("R7.6 \u64A4\u9500\u540E\u7528\u6237\u624B\u5199\u7684\u5907\u6CE8\u4ECD\u5728", draft.notes.some((n) => n.id === "n_user_new"), true);
  eq("R7.7 \u64A4\u9500\u540E note \u51C0\u589E 1 \u6761\uFF08\u53EA\u5C11\u4E86 system \u90A3\u6761\uFF09", draft.notes.length, before.notes.length + 1);
  eq("R7.8 \u64A4\u9500\u540E lastActivityAt \u7528\u6700\u65B0\u771F\u5B9E\u4E92\u52A8\u91CD\u7B97", after.lastActivityAt, "2025-03-12T01:30:00.000Z");
  eq("R7.9 \u64A4\u9500\u4E0D\u78B0\u5176\u4ED6\u6295\u9012\uFF08\u5B57\u8282\u72B6\u6001\u4E0D\u53D8\uFF09", draft.applications.find((a) => a.id === "app_bytedance").status, before.applications.find((a) => a.id === "app_bytedance").status);
  eq("R7.10 \u64A4\u9500\u4E0D\u78B0\u5176\u4ED6\u6295\u9012\u7684 note \u6570", draft.notes.filter((n) => n.applicationId === "app_bytedance").length, before.notes.filter((n) => n.applicationId === "app_bytedance").length);
  const d2 = JSON.parse(JSON.stringify(base));
  const t2 = d2.applications.find((a) => a.id === "app_meituan");
  t2.status = "rejected";
  t2.rejectedAtRound = 2;
  revertStatusChange(d2, { ...undo, createdNoteId: "n_nonexistent" });
  eq("R7.11 \u64A4\u9500 rejected \u4F1A\u628A rejectedAtRound \u8FD8\u539F\u4E3A null", d2.applications.find((a) => a.id === "app_meituan").rejectedAtRound, null);
  const d3 = JSON.parse(JSON.stringify(base));
  let threw = false;
  try {
    revertStatusChange(d3, { ...undo, createdNoteId: "not_exist" });
  } catch {
    threw = true;
  }
  ok("R7.12 \u64A4\u9500\u4E00\u4E2A\u4E0D\u5B58\u5728\u7684\u8BB0\u5F55 id \u4E0D\u629B\u5F02\u5E38", threw === false);
}
{
  const mkDB = (interviews, settings = defaultSettings()) => ({
    settings,
    companies: [{ id: "c1", name: "\u67D0\u516C\u53F8", createdAt: NOW.toISOString() }],
    applications: [mkApp({ id: "a1", companyId: "c1", status: "scheduled" })],
    interviews,
    notes: []
  });
  const ivAt = (iso, result = "pending") => ({
    id: "iv1",
    applicationId: "a1",
    round: 1,
    scheduledAt: iso,
    durationMin: 45,
    format: "video",
    result
  });
  const today = (h, m = 0) => new Date(2025, 2, 12, h, m).toISOString();
  const at14 = (now) => buildTodos(mkDB([ivAt(today(15, 0))]), now);
  {
    const t = at14(new Date(2025, 2, 12, 9, 0));
    eq("R8.1 09:00\uFF08\u672A\u5F00\u59CB\uFF09\u2192 \u4ECA\u65E5\u9762\u8BD5 1 / \u5F85\u8BB0\u7ED3\u679C 0", [t.todayInterview.length, t.needResult.length], [1, 0]);
    eq("R8.2 09:00 \u9636\u6BB5\u6587\u6848\u4E3A\u7A7A", interviewPhaseLabel(ivAt(today(15, 0)), new Date(2025, 2, 12, 9, 0), SETTINGS), "");
  }
  {
    const now = new Date(2025, 2, 12, 15, 20);
    const t = at14(now);
    eq("R8.3 15:20\uFF08\u8FDB\u884C\u4E2D\uFF09\u2192 \u4ECA\u65E5\u9762\u8BD5 1 / \u5F85\u8BB0\u7ED3\u679C 0", [t.todayInterview.length, t.needResult.length], [1, 0]);
    eq("R8.4 \u8FDB\u884C\u4E2D\u6587\u6848", interviewPhaseLabel(ivAt(today(15, 0)), now, SETTINGS), "\u9762\u8BD5\u8FDB\u884C\u4E2D");
  }
  {
    const now = new Date(2025, 2, 12, 16, 0);
    const t = at14(now);
    eq("R8.5 16:00 \u2192 \u4ECD\u5728\u300C\u4ECA\u65E5\u9762\u8BD5\u300D\uFF0C\u4E0D\u8FDB\u5F85\u8BB0\u7ED3\u679C", [t.todayInterview.length, t.needResult.length], [1, 0]);
    eq("R8.6 16:00 \u9636\u6BB5\u6587\u6848\u300C\u5DF2\u7ED3\u675F\uFF0C\u7A0D\u540E\u8BB0\u7ED3\u679C\u300D", interviewPhaseLabel(ivAt(today(15, 0)), now, SETTINGS), "\u5DF2\u7ED3\u675F\uFF0C\u7A0D\u540E\u8BB0\u7ED3\u679C");
  }
  {
    const t = at14(new Date(2025, 2, 12, 19, 59));
    eq("R8.7 19:59 \u2192 \u4ECD\u4E0D\u50AC\u7ED3\u679C\uFF08\u8FB9\u754C\u5185\u4FA7\uFF09", [t.todayInterview.length, t.needResult.length], [1, 0]);
  }
  {
    const now = new Date(2025, 2, 12, 20, 0);
    const t = at14(now);
    eq("R8.8 20:00 \u2192 \u7FFB\u8FDB\u300C\u5F85\u8BB0\u7ED3\u679C\u300D", [t.todayInterview.length, t.needResult.length], [0, 1]);
    eq("R8.9 20:00 \u9636\u6BB5\u6587\u6848\u300C\u5DF2\u7ED3\u675F\uFF0C\u5F85\u8BB0\u7ED3\u679C\u300D", interviewPhaseLabel(ivAt(today(15, 0)), now, SETTINGS), "\u5DF2\u7ED3\u675F\uFF0C\u5F85\u8BB0\u7ED3\u679C");
  }
  {
    const t = at14(new Date(2025, 2, 12, 20, 30));
    eq("R8.10 20:30 \u2192 \u5F85\u8BB0\u7ED3\u679C 1", [t.todayInterview.length, t.needResult.length], [0, 1]);
  }
  {
    const now = new Date(2025, 2, 12, 9, 0);
    const t = buildTodos(mkDB([ivAt(new Date(2025, 2, 11, 15, 0).toISOString())]), now);
    eq("R8.11 \u6628\u5929\u90A3\u573A pending \u2192 \u5F85\u8BB0\u7ED3\u679C 1", [t.todayInterview.length, t.needResult.length], [0, 1]);
  }
  {
    const t = buildTodos(mkDB([ivAt(new Date(2025, 2, 13, 15, 0).toISOString())]), NOW);
    eq("R8.12 \u660E\u5929\u90A3\u573A \u2192 \u4E24\u8FB9\u90FD\u4E0D\u8FDB", [t.todayInterview.length, t.needResult.length], [0, 0]);
  }
  {
    const t = buildTodos(mkDB([ivAt(new Date(2025, 2, 11, 15, 0).toISOString(), "passed")]), NOW);
    eq("R8.13 \u5DF2\u8BB0 passed \u7684\u4E0D\u8FDB\u5F85\u8BB0\u7ED3\u679C", [t.todayInterview.length, t.needResult.length], [0, 0]);
  }
  {
    const s = { ...defaultSettings(), resultPromptHour: 1 };
    const t = buildTodos(mkDB([ivAt(today(15, 0))], s), new Date(2025, 2, 12, 16, 0));
    eq("R8.14 resultPromptHour=1 \u65F6 16:00 \u2192 \u5F85\u8BB0\u7ED3\u679C", [t.todayInterview.length, t.needResult.length], [0, 1]);
  }
  {
    const db = mkDB([ivAt(new Date(2025, 2, 11, 15, 0).toISOString())]);
    db.applications[0].status = "rejected";
    const t = buildTodos(db, NOW);
    eq("R8.15 \u7EC8\u6001\u6295\u9012\u7684\u9762\u8BD5\u4E0D\u8FDB\u5F85\u8BB0\u7ED3\u679C", [t.todayInterview.length, t.needResult.length], [0, 0]);
  }
}
var sampleDB = buildSampleDB(NOW);
{
  eq("R9.1 8 \u6761\u6295\u9012 / 7 \u79CD\u72B6\u6001", [sampleDB.applications.length, new Set(sampleDB.applications.map((a) => a.status)).size], [8, 7]);
  const funnel = buildFunnel(sampleDB);
  eq("R9.2 \u6F0F\u6597\u8BA1\u6570 8/7/5/4/2/1", funnel.map((f) => f.count), [8, 7, 5, 4, 2, 1]);
  eq("R9.3 \u8F6C\u5316\u7387", [Math.round(funnel[1].rate * 100), Math.round(funnel[2].rate * 100), Math.round(funnel[4].rate * 100), Math.round(funnel[5].rate * 100)], [88, 71, 50, 50]);
  const todos = buildTodos(sampleDB, NOW);
  eq("R9.4 \u6C89\u9ED8 2 \u5BB6", todos.stale.map((t) => t.app.id).sort(), ["app_bytedance", "app_meituan"]);
  eq("R9.5 \u8BE5\u8DDF\u8FDB 2 \u5BB6", todos.warn.map((t) => t.app.id).sort(), ["app_alibaba", "app_xiaohongshu"]);
  eq("R9.6 \u60F3\u6295\u8D85\u671F 1 \u5BB6", todos.wishlistExpired.map((t) => t.app.id), ["app_netease"]);
  eq("R9.7 09:00 \u65F6\u4ECA\u5929\u9762\u8BD5 1 \u573A\uFF08\u817E\u8BAF\uFF09", todos.todayInterview.map((t) => t.interview.id), ["iv_tencent_1"]);
  const items = buildActionItems(buildTodos(sampleDB, NOW), sampleDB.companies, sampleDB.settings, NOW);
  eq("R9.8 \u5F85\u529E 6 \u6761", items.length, 6);
  eq("R9.9 \u6392\u5E8F \u7EA2>\u84DD>\u9EC4", items.map((i) => i.tone), ["red", "red", "blue", "amber", "amber", "amber"]);
  const channels = buildChannelStats(sampleDB);
  eq("R9.10 BOSS 3 \u6295 2 \u56DE\u590D", [channels.find((c) => c.channel === "boss")?.total, channels.find((c) => c.channel === "boss")?.replied], [3, 2]);
  eq("R9.11 \u5185\u63A8 100%", Math.round((channels.find((c) => c.channel === "referral")?.rate ?? 0) * 100), 100);
  const resumes = buildResumeStats(sampleDB);
  eq("R9.12 v3 5 \u6295 3 \u8FDB\u9762", [resumes.find((r) => r.version === "v3-\u524D\u7AEF-\u9879\u76EE\u7248")?.total, resumes.find((r) => r.version === "v3-\u524D\u7AEF-\u9879\u76EE\u7248")?.interviewed], [5, 3]);
  const todosNight = buildTodos(sampleDB, new Date(2025, 2, 12, 21, 0));
  eq("R9.13 21:00 \u65F6\u817E\u8BAF\u90A3\u573A\u7FFB\u8FDB\u5F85\u8BB0\u7ED3\u679C", [todosNight.todayInterview.length, todosNight.needResult.map((t) => t.interview.id)], [0, ["iv_tencent_1"]]);
}
{
  const s = defaultSettings();
  s.courseSlots = [{ weekday: 4, start: "14:00", end: "15:40", name: "\u8BA1\u7B97\u673A\u7F51\u7EDC" }];
  const sNoCourse = defaultSettings();
  const mkIv = (id, iso, durationMin = 60, applicationId = "app_x") => ({ id, applicationId, round: 1, scheduledAt: iso, durationMin, format: "video", result: "pending" });
  const thursday = (h, m = 0) => new Date(2025, 2, 13, h, m).toISOString();
  const apps = [mkApp({ id: "app_x" }), mkApp({ id: "app_y", jobTitle: "\u53E6\u4E00\u4E2A\u5C97\u4F4D", companyId: "c_y" })];
  const target = mkIv("t", thursday(15, 0));
  eq("R10.1 \u540C\u65E5\u91CD\u53E0 \u2192 1 \u6761", findConflicts(target, [target, mkIv("o1", thursday(15, 30), 60, "app_y")], apps, sNoCourse).length, 1);
  ok("R10.2 \u51B2\u7A81\u6587\u6848\u542B\u300C\u53E6\u4E00\u573A\u9762\u8BD5\u300D", findConflicts(target, [target, mkIv("o1", thursday(15, 30), 60, "app_y")], apps, sNoCourse)[0].includes("\u53E6\u4E00\u573A\u9762\u8BD5"));
  eq("R10.3 \u540C\u65E5\u4E0D\u91CD\u53E0 \u2192 0", findConflicts(mkIv("t2", thursday(20, 0)), [mkIv("t2", thursday(20, 0)), mkIv("o2", thursday(17, 0))], apps, sNoCourse).length, 0);
  eq("R10.4 \u5DF2\u53D6\u6D88\u4E0D\u7B97\u51B2\u7A81", findConflicts(target, [target, { ...mkIv("o3", thursday(15, 10)), result: "cancelled" }], apps, sNoCourse).length, 0);
  eq("R10.5 \u4E0D\u540C\u5929\u4E0D\u7B97\u51B2\u7A81", findConflicts(target, [target, mkIv("o4", new Date(2025, 2, 14, 15, 0).toISOString())], apps, sNoCourse).length, 0);
  const clashMsgs = findConflicts(mkIv("c", thursday(14, 30), 45), [mkIv("c", thursday(14, 30), 45)], apps, s);
  eq("R10.6 \u649E\u8BFE \u2192 1 \u6761", clashMsgs.length, 1);
  ok("R10.7 \u649E\u8BFE\u6587\u6848\u542B\u8BFE\u7A0B\u540D", clashMsgs[0].includes("\u8BA1\u7B97\u673A\u7F51\u7EDC"));
  eq("R10.8 16:00 \u4E0D\u649E\u8BFE", findConflicts(mkIv("c2", thursday(16, 0), 45), [mkIv("c2", thursday(16, 0), 45)], apps, s).length, 0);
  eq("R10.9 15:40 \u63A5\u8FB9\u4E0D\u7B97\u91CD\u53E0", findConflicts(mkIv("c3", thursday(15, 40), 45), [mkIv("c3", thursday(15, 40), 45)], apps, s).length, 0);
  const sampleConflict = findConflicts(sampleDB.interviews.find((i) => i.id === "iv_alibaba_2"), sampleDB.interviews, sampleDB.applications, sampleDB.settings);
  ok("R10.10 \u793A\u4F8B\u6570\u636E\u963F\u91CC\u4E8C\u9762\u649E\u300A\u8BA1\u7B97\u673A\u7F51\u7EDC\u300B", sampleConflict.some((m) => m.includes("\u8BA1\u7B97\u673A\u7F51\u7EDC")), JSON.stringify(sampleConflict));
}
{
  const text = exportJSON(sampleDB);
  const back = importFromText(text);
  ok("R11.1 \u5BFC\u51FA\u53EF\u5BFC\u5165", back.ok);
  if (back.ok) {
    eq("R11.2 \u6570\u91CF\u4E00\u81F4", [back.db.companies.length, back.db.applications.length, back.db.interviews.length, back.db.notes.length], [sampleDB.companies.length, sampleDB.applications.length, sampleDB.interviews.length, sampleDB.notes.length]);
    eq("R11.3 \u516C\u53F8\u540D/\u5C97\u4F4D/\u72B6\u6001\u4E00\u81F4", [back.db.companies.map((c) => c.name).sort(), back.db.applications.map((a) => a.jobTitle).sort(), back.db.applications.map((a) => a.status).sort()], [sampleDB.companies.map((c) => c.name).sort(), sampleDB.applications.map((a) => a.jobTitle).sort(), sampleDB.applications.map((a) => a.status).sort()]);
    eq("R11.4 \u8BBE\u7F6E/\u8BFE\u7A0B\u8868\u4E00\u81F4", [back.db.settings.staleAfterDays, back.db.settings.courseSlots.length], [sampleDB.settings.staleAfterDays, sampleDB.settings.courseSlots.length]);
    eq("R11.5 \u6F0F\u6597\u4E00\u81F4", buildFunnel(back.db).map((f) => f.count), buildFunnel(sampleDB).map((f) => f.count));
    eq("R11.6 resultPromptHour \u5BFC\u51FA\u540E\u4ECD\u4E3A 20", back.db.settings.resultPromptHour, 20);
  }
  const legacy = {
    settings: { schemaVersion: 1, warnAfterDays: 3, staleAfterDays: 7, interviewResultWaitDays: 5, wishlistExpireDays: 7, weeklyApplyGoal: 8 },
    companies: [{ id: "c1", name: "\u8001\u516C\u53F8" }],
    applications: [{ id: "a1", companyId: "c1", jobTitle: "\u8001\u5C97\u4F4D", status: "applied", statusChangedAt: "2025-03-01T00:00:00.000Z" }]
  };
  const legacyRes = validateImport(legacy);
  ok("R11.7 \u65E0 resultPromptHour \u7684\u8001\u5907\u4EFD\u53EF\u5BFC\u5165", legacyRes.ok);
  if (legacyRes.ok) {
    eq("R11.8 \u8001\u5907\u4EFD\u81EA\u52A8\u8865 resultPromptHour=20", legacyRes.db.settings.resultPromptHour, 20);
    eq("R11.9 \u8001\u5907\u4EFD schemaVersion \u4ECD\u4E3A 1", legacyRes.db.settings.schemaVersion, 1);
  }
  const custom = validateImport({ settings: { schemaVersion: 1, resultPromptHour: 18 }, companies: [], applications: [] });
  ok("R11.10 \u81EA\u5B9A\u4E49 resultPromptHour=18 \u88AB\u63A5\u53D7", custom.ok && custom.db.settings.resultPromptHour === 18);
  const bad = importFromText("{ not json ");
  eq("R11.11 \u975E\u6CD5 JSON \u62A5\u9519", bad.ok === false ? bad.error.includes("\u5408\u6CD5\u7684 JSON") : false, true);
  eq("R11.12 \u975E\u6CD5 status \u62A5\u9519", validateImport({ settings: { schemaVersion: 1 }, companies: [{ id: "c1", name: "X" }], applications: [{ id: "a1", companyId: "c1", jobTitle: "J", status: "unknown" }] }).ok, false);
  eq("R11.13 \u5F15\u7528\u4E0D\u5B58\u5728\u516C\u53F8\u62E6\u4E0B", validateImport({ settings: { schemaVersion: 1 }, companies: [], applications: [{ id: "a1", companyId: "c_missing", jobTitle: "J", status: "applied" }] }).ok, false);
  eq("R11.14 schemaVersion=2 \u62A5\u9519", validateImport({ settings: { schemaVersion: 2 } }).ok, false);
}
{
  const real = globalThis.localStorage;
  let store = {};
  globalThis.localStorage = {
    getItem: (k) => k in store ? store[k] : null,
    setItem: (k, v) => {
      store[k] = v;
    },
    removeItem: (k) => {
      delete store[k];
    }
  };
  store = {};
  const empty = loadDB();
  eq("R12.1 \u7A7A\u5B58\u50A8 \u2192 \u7A7A\u5E93 + \u65E0\u9519", [empty.db.applications.length, empty.error], [0, null]);
  eq("R12.2 \u9ED8\u8BA4\u9608\u503C + resultPromptHour", [empty.db.settings.staleAfterDays, empty.db.settings.resultPromptHour], [7, 20]);
  store = { "jobdesk.v1": "{\u574F\u6389\u7684 json" };
  const corrupted = loadDB();
  eq("R12.3 \u574F JSON \u2192 \u964D\u7EA7\u7A7A\u5E93", corrupted.db.applications.length, 0);
  ok("R12.4 \u574F JSON \u2192 \u6709\u63D0\u793A", typeof corrupted.error === "string" && corrupted.error.length > 0, corrupted.error ?? "");
  store = { "jobdesk.v1": JSON.stringify({ settings: { schemaVersion: 1 }, applications: "not-array" }) };
  const badShape = loadDB();
  eq("R12.5 \u7ED3\u6784\u9519\u8BEF \u2192 \u964D\u7EA7", badShape.db.applications.length, 0);
  ok("R12.6 \u7ED3\u6784\u9519\u8BEF \u2192 \u6709\u63D0\u793A", Boolean(badShape.error));
  globalThis.localStorage = { getItem: () => null, setItem: () => {
    throw new Error("QuotaExceededError");
  }, removeItem: () => void 0 };
  const saveErr = saveDB(emptyDB());
  ok("R12.7 \u5199\u6EE1 \u2192 \u8FD4\u56DE\u53EF\u8BFB\u9519\u8BEF", typeof saveErr === "string" && saveErr.includes("\u4FDD\u5B58\u5931\u8D25"), saveErr ?? "null");
  globalThis.localStorage = { getItem: () => {
    throw new Error("SecurityError");
  }, setItem: () => void 0, removeItem: () => void 0 };
  const denied = loadDB();
  eq("R12.8 \u8BFB\u88AB\u7981\u6B62 \u2192 \u964D\u7EA7\u7A7A\u5E93", denied.db.applications.length, 0);
  ok("R12.9 \u8BFB\u88AB\u7981\u6B62 \u2192 \u63D0\u793A", Boolean(denied.error));
  globalThis.localStorage = real;
}
{
  const app = mkApp({ status: "rejected", appliedAt: "2025-03-01" });
  eq("R13.1 \u5DF2\u6302\u65E0\u9762\u8BD5 \u2192 1", stageRankOf(app, []), 1);
  eq("R13.2 \u5DF2\u6302\u6709\u9762\u8BD5 \u2192 3", stageRankOf(app, [{ id: "i1", applicationId: "app_x", round: 1, scheduledAt: NOW.toISOString(), format: "video", result: "failed" }]), 3);
  eq("R13.3 \u5DF2\u653E\u5F03\u65E0 appliedAt \u65E0\u9762\u8BD5 \u2192 0", stageRankOf(mkApp({ status: "dropped", appliedAt: void 0 }), []), 0);
}
console.log("\n=== Round 2 \u7B97\u6CD5\u65AD\u8A00\u660E\u7EC6 ===");
for (const row of rows) {
  console.log(`${row.ok ? "PASS" : "FAIL"}  ${row.name}${row.ok ? "" : `  \u2190 \u671F\u671B ${row.expect} / \u5B9E\u9645 ${row.actual}`}`);
}
console.log(`
=== \u6C47\u603B: ${pass} PASS / ${fail} FAIL / \u5171 ${rows.length} ===`);
if (fail > 0) {
  console.log("\n\u5931\u8D25\u6E05\u5355:");
  rows.filter((r) => !r.ok).forEach((r) => console.log(`  - ${r.name}: \u671F\u671B ${r.expect}\uFF0C\u5B9E\u9645 ${r.actual}`));
}
