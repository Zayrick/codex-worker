import { useCallback, useEffect, useMemo, useState } from "react";
import "./StatusUsage.css";

const REFRESH_INTERVAL_MS = 5 * 60 * 1_000;
const CLOCK_INTERVAL_MS = 1_000;
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const MOCK_USAGE = import.meta.env.DEV && new URLSearchParams(window.location.search).has("mock");

type QuotaKind = "five_hour" | "weekly" | "monthly" | "primary" | "secondary";
type QuotaCategory = "codex" | "code_review" | "additional";

interface UsageWindow {
	id: string;
	category: QuotaCategory;
	name: string;
	kind: QuotaKind;
	usedPercent?: number | null;
	remainingPercent?: number | null;
	limitWindowSeconds?: number | null;
	resetAt?: number | null;
}

interface UsageSnapshot {
	sampledAt: number;
	planType?: string | null;
	windows: UsageWindow[];
}

interface TimelineSegment {
	start: number;
	end: number;
	left: number;
	width: number;
	state: "past" | "live" | "future";
	isReportedCycle: boolean;
}

function StatusUsage() {
	const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [now, setNow] = useState(() => Date.now());

	const load = useCallback(async (signal?: AbortSignal) => {
		try {
			if (MOCK_USAGE) {
				setSnapshot(mockSnapshot(Date.now()));
				setError(null);
				return;
			}
			const init: RequestInit = {
				headers: { accept: "application/json" },
			};
			if (signal) init.signal = signal;
			const response = await fetch("/status/usage/data", init);
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const value: unknown = await response.json();
			const next = parseSnapshot(value);
			setSnapshot(next);
			setError(null);
		} catch (cause) {
			if (cause instanceof DOMException && cause.name === "AbortError") return;
			setError("暂时无法读取用量缓存，将在下个刷新周期重试。");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		void load(controller.signal);
		const refresh = window.setInterval(() => {
			if (!document.hidden) void load();
		}, REFRESH_INTERVAL_MS);
		const clock = window.setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS);
		const onVisibilityChange = () => {
			if (!document.hidden) {
				setNow(Date.now());
				void load();
			}
		};
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () => {
			controller.abort();
			window.clearInterval(refresh);
			window.clearInterval(clock);
			document.removeEventListener("visibilitychange", onVisibilityChange);
		};
	}, [load]);

	const spanAnchor = snapshot?.sampledAt ?? now;
	const span = useMemo(
		() => quotaSpan(snapshot?.windows ?? [], spanAnchor),
		[snapshot, spanAnchor],
	);
	const days = useMemo(() => dayTicks(span.start, span.end), [span]);
	const nowLeft = percentAt(now, span.start, span.end);

	return (
		<main className="usage-page">
			<section className="usage-shell" aria-labelledby="usage-title">
				<header className="usage-header">
					<div>
						<p className="usage-eyebrow">CODEX STATUS</p>
						<h1 id="usage-title">配额窗口</h1>
					</div>
				</header>

				{error ? <div className="usage-message usage-error" role="status">{error}</div> : null}
				{loading && !snapshot ? <LoadingTimeline /> : null}
				{!loading && !snapshot ? (
					<div className="usage-message" role="status">暂无用量缓存，定时任务完成首次采样后会自动显示。</div>
				) : null}

				{snapshot ? (
					<div className="timeline-card">
						<div className="timeline-scroll">
							<div className="timeline-grid">
								<div className="timeline-axis">
									<div className="axis-heading">
										<span>配额</span>
										{snapshot.planType ? <b>{formatPlan(snapshot.planType)}</b> : null}
									</div>
									<div className="axis-days">
										{days.map((day) => (
											<div className={day.isToday ? "axis-day today" : "axis-day"} key={day.at} style={{ width: `${day.width}%` }}>
												<span>{day.weekday}</span>
												<b>{day.label}</b>
											</div>
										))}
									</div>
								</div>
								{nowLeft !== null ? (
									<span
										className="timeline-now-overlay"
										aria-hidden="true"
										style={{ gridRow: `2 / span ${snapshot.windows.length}` }}
									>
										<i style={{ left: `${nowLeft}%` }} />
									</span>
								) : null}

								{snapshot.windows.map((window) => (
									<QuotaLane
										key={window.id}
										days={days}
										now={now}
										span={span}
										window={window}
									/>
								))}
							</div>
						</div>
						<footer className="timeline-legend">
							<span><i className="legend-live" />当前周期</span>
							<span><i className="legend-future" />后续周期</span>
							<span><i className="legend-past" />本周已结束</span>
							<span className="legend-note">填充表示当前周期剩余额度</span>
						</footer>
					</div>
				) : null}
			</section>
		</main>
	);
}

function QuotaLane({ window, span, now, days }: {
	window: UsageWindow;
	span: { start: number; end: number };
	now: number;
	days: ReturnType<typeof dayTicks>;
}) {
	const segments = useMemo(
		() => projectWindow(window, span.start, span.end, now),
		[window, span, now],
	);
	const remaining = finitePercent(window.remainingPercent);
	const categoryLabel = window.category === "code_review" ? "代码审查" : window.name || "Codex";

	return (
		<div className={`quota-lane category-${window.category}`}>
			<div className="lane-heading">
				<div><span className="lane-dot" /><strong>{categoryLabel}</strong><em>{periodLabel(window)}</em></div>
			</div>
			<div className="lane-track">
				<div className="track-days">
					{days.map((day) => <span className={day.isToday ? "today" : ""} key={day.at} style={{ width: `${day.width}%` }} />)}
				</div>
				{segments.length === 0 ? <span className="lane-empty">暂无可投影的重置时间</span> : null}
				{segments.map((segment) => (
					<div
						className={`quota-segment ${segment.state}${segment.isReportedCycle && segment.width <= 12 ? " narrow-current" : ""}`}
						key={segment.start}
						style={{ left: `${segment.left}%`, width: `${segment.width}%` }}
						title={`${formatDateTime(segment.start)} → ${formatDateTime(segment.end)}${segment.isReportedCycle && remaining !== null ? `\n剩余 ${Math.round(remaining)}%` : ""}`}
					>
						{segment.isReportedCycle && remaining !== null ? (
							<span className="segment-remaining" style={{ width: `${remaining}%` }} />
						) : null}
						{segment.isReportedCycle && remaining !== null ? (
							<b className="segment-summary">{Math.round(remaining)}% · {formatRefreshDate(segment.end)}</b>
						) : null}
					</div>
				))}
			</div>
		</div>
	);
}

function LoadingTimeline() {
	return <div className="timeline-loading" role="status"><span /><span /><span /></div>;
}

function quotaSpan(windows: UsageWindow[], now: number): { start: number; end: number } {
	const starts = windows.flatMap((window) => {
		const resetAt = validTimestamp(window.resetAt);
		const period = windowPeriodMs(window);
		return resetAt !== null && period !== null
			? [resetAt - period]
			: [];
	});
	const firstCycleStart = starts.length > 0 ? Math.min(...starts) : now;
	const start = startOfLocalDay(firstCycleStart);
	const end = startOfNextLocalDay(Math.max(firstCycleStart + 7 * DAY_MS, now + 7 * DAY_MS));
	return { start, end };
}

function startOfLocalDay(value: number): number {
	const date = new Date(value);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

function startOfNextLocalDay(value: number): number {
	const date = new Date(value);
	date.setHours(24, 0, 0, 0);
	return date.getTime();
}

function dayTicks(start: number, end: number) {
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const result: { at: number; label: string; weekday: string; isToday: boolean; width: number }[] = [];
	const cursor = new Date(start);
	while (cursor.getTime() < end) {
		const at = cursor.getTime();
		const next = new Date(cursor);
		next.setHours(24, 0, 0, 0);
		const cellEnd = Math.min(next.getTime(), end);
		result.push({
			at,
			label: new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(cursor),
			weekday: new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(cursor),
			isToday: at <= today.getTime() && cellEnd > today.getTime(),
			width: ((cellEnd - at) / (end - start)) * 100,
		});
		cursor.setTime(cellEnd);
	}
	return result;
}

function projectWindow(window: UsageWindow, start: number, end: number, now: number): TimelineSegment[] {
	const resetAt = validTimestamp(window.resetAt);
	const period = windowPeriodMs(window);
	if (resetAt === null || period === null) return [];
	if (period < 60_000 || (end - start) / period > 1_000) return [];
	let windowEnd = resetAt;
	while (windowEnd <= start) windowEnd += period;
	const segments: TimelineSegment[] = [];
	while (windowEnd - period < end) {
		const windowStart = windowEnd - period;
		const clippedStart = Math.max(start, windowStart);
		const clippedEnd = Math.min(end, windowEnd);
		if (clippedEnd > clippedStart) {
			segments.push({
				start: windowStart,
				end: windowEnd,
				left: ((clippedStart - start) / (end - start)) * 100,
				width: ((clippedEnd - clippedStart) / (end - start)) * 100,
				state: windowEnd <= now ? "past" : windowStart <= now ? "live" : "future",
				isReportedCycle: Math.abs(windowEnd - resetAt) < 1_000,
			});
		}
		windowEnd += period;
	}
	return segments;
}

function parseSnapshot(value: unknown): UsageSnapshot | null {
	if (!isRecord(value)) throw new Error("Invalid usage response");
	if (value.snapshot === null) return null;
	const sampledAt = validTimestamp(value.sampledAt);
	if (sampledAt === null || !Array.isArray(value.windows)) throw new Error("Invalid usage snapshot");
	const windows = value.windows.map(parseWindow).filter((entry): entry is UsageWindow => entry !== null);
	return {
		sampledAt,
		planType: typeof value.planType === "string" ? value.planType : null,
		windows,
	};
}

function parseWindow(value: unknown): UsageWindow | null {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") return null;
	const kinds: QuotaKind[] = ["five_hour", "weekly", "monthly", "primary", "secondary"];
	const categories: QuotaCategory[] = ["codex", "code_review", "additional"];
	if (!kinds.includes(value.kind as QuotaKind) || !categories.includes(value.category as QuotaCategory)) return null;
	return {
		id: value.id,
		name: value.name,
		kind: value.kind as QuotaKind,
		category: value.category as QuotaCategory,
		usedPercent: optionalNumber(value.usedPercent),
		remainingPercent: optionalNumber(value.remainingPercent),
		limitWindowSeconds: optionalNumber(value.limitWindowSeconds),
		resetAt: optionalNumber(value.resetAt),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function validTimestamp(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function finitePercent(value: number | null | undefined): number | null {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
}

function percentAt(value: number, start: number, end: number): number | null {
	return value >= start && value < end ? ((value - start) / (end - start)) * 100 : null;
}

function periodLabel(window: UsageWindow): string {
	if (window.kind === "five_hour") return "5 小时";
	if (window.kind === "weekly") return "7 天";
	if (window.kind === "monthly") return "月度";
	if (window.limitWindowSeconds) {
		const hours = window.limitWindowSeconds / 3600;
		return hours < 24 ? `${Math.round(hours)} 小时` : `${Math.round(hours / 24)} 天`;
	}
	return window.kind === "primary" ? "主要额度" : "次要额度";
}

function windowPeriodMs(window: UsageWindow): number | null {
	if (window.kind === "five_hour") return 5 * HOUR_MS;
	if (window.kind === "weekly") return 7 * DAY_MS;
	const seconds = optionalNumber(window.limitWindowSeconds);
	return seconds !== null && seconds > 0 ? seconds * 1_000 : null;
}

function formatPlan(value: string): string {
	return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDateTime(value: number): string {
	return new Intl.DateTimeFormat("zh-CN", {
		month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
	}).format(new Date(value));
}

function formatRefreshDate(value: number): string {
	return new Intl.DateTimeFormat("zh-CN", {
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(new Date(value));
}

function mockSnapshot(now: number): UsageSnapshot {
	return {
		sampledAt: now,
		planType: "pro",
		windows: [
			{
				id: "mock-codex-five-hour",
				category: "codex",
				name: "Codex",
				kind: "five_hour",
				usedPercent: 32,
				remainingPercent: 68,
				limitWindowSeconds: 5 * 60 * 60,
				resetAt: now + 2.25 * HOUR_MS,
			},
			{
				id: "mock-codex-weekly",
				category: "codex",
				name: "Codex",
				kind: "weekly",
				usedPercent: 59,
				remainingPercent: 41,
				limitWindowSeconds: 7 * 24 * 60 * 60,
				resetAt: now + 3.8 * DAY_MS,
			},
			{
				id: "mock-spark-weekly",
				category: "additional",
				name: "GPT-5.3-Codex-Spark",
				kind: "weekly",
				usedPercent: 77,
				remainingPercent: 23,
				limitWindowSeconds: 7 * 24 * 60 * 60,
				resetAt: now + 5.4 * DAY_MS,
			},
			{
				id: "mock-review-weekly",
				category: "code_review",
				name: "Code Review",
				kind: "weekly",
				usedPercent: 16,
				remainingPercent: 84,
				limitWindowSeconds: 7 * 24 * 60 * 60,
				resetAt: now + 1.6 * DAY_MS,
			},
		],
	};
}

export default StatusUsage;
