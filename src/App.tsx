import {
	useEffect,
	useMemo,
	useRef,
	useState,
	type FormEvent,
	type ReactNode,
} from "react";
import {
	AdminApiClient,
	AdminApiError,
	AdminSessionExpiredError,
	type ClientApiKey,
	type DeviceAuthorization,
	type OAuthStatus,
	type QuotaWindow,
	type SubscriptionInfo,
	type SubscriptionMetadata,
} from "./admin-api";
import "./App.css";

const MANAGEMENT_PATH_PATTERN = /^\/[A-Za-z0-9_-]{1,128}\/admin\/?$/;

type Screen = "loading" | "login" | "dashboard" | "invalid-path";
type Notice = { tone: "success" | "error"; text: string };
type EditableKey = ClientApiKey | "new" | null;

function App() {
	const basePath = useMemo(() => managementBasePath(window.location.pathname), []);
	const api = useMemo(
		() => (basePath ? new AdminApiClient(basePath) : null),
		[basePath],
	);
	const [screen, setScreen] = useState<Screen>(
		basePath ? "loading" : "invalid-path",
	);
	const [loginLoading, setLoginLoading] = useState(false);
	const [loginError, setLoginError] = useState<string | null>(null);
	const [oauth, setOAuth] = useState<OAuthStatus | null>(null);
	const [oauthRemoving, setOAuthRemoving] = useState(false);
	const [subscription, setSubscription] = useState<
		SubscriptionInfo | SubscriptionMetadata | null
	>(null);
	const [subscriptionLoading, setSubscriptionLoading] = useState(false);
	const [subscriptionError, setSubscriptionError] = useState<string | null>(null);
	const [apiKeys, setApiKeys] = useState<ClientApiKey[]>([]);
	const [keysRefreshing, setKeysRefreshing] = useState(false);
	const [keyEditor, setKeyEditor] = useState<EditableKey>(null);
	const [keySaving, setKeySaving] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<string | null>(null);
	const [keyDeleting, setKeyDeleting] = useState(false);
	const [deviceAuthorization, setDeviceAuthorization] =
		useState<DeviceAuthorization | null>(null);
	const [deviceLoading, setDeviceLoading] = useState(false);
	const [deviceError, setDeviceError] = useState<string | null>(null);
	const [notice, setNotice] = useState<Notice | null>(null);
	const [now, setNow] = useState(() => Date.now());

	const mountedRef = useRef(false);
	const initializedRef = useRef(false);
	const deviceRequestInFlightRef = useRef(false);
	const pollTimerRef = useRef<number | null>(null);
	const initializeRef = useRef(initialize);
	initializeRef.current = initialize;

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			clearPollTimer();
		};
	}, []);

	useEffect(() => {
		if (initializedRef.current || !api) return;
		initializedRef.current = true;
		void initializeRef.current();
	}, [api]);

	useEffect(() => {
		if (!notice) return;
		const timer = window.setTimeout(() => setNotice(null), 4_500);
		return () => window.clearTimeout(timer);
	}, [notice]);

	useEffect(() => {
		if (screen !== "dashboard") return;
		const timer = window.setInterval(() => {
			if (!document.hidden) setNow(Date.now());
		}, 60_000);
		return () => window.clearInterval(timer);
	}, [screen]);

	async function initialize(): Promise<void> {
		if (!api) return;
		try {
			const state = await api.getState();
			if (!mountedRef.current) return;
			setOAuth(state.oauth);
			setSubscription(state.subscription);
			setApiKeys(state.apiKeys);
			setScreen("dashboard");
			setLoginError(null);
			if (state.oauth) {
				void refreshSubscription(true);
			} else {
				void beginDeviceLogin();
			}
		} catch (error) {
			if (!mountedRef.current) return;
			if (error instanceof AdminSessionExpiredError) {
				resetForLogin();
				return;
			}
			setScreen("login");
			setLoginError(errorMessage(error, "无法读取管理状态，请稍后重试。"));
		}
	}

	async function handleLogin(secret: string): Promise<void> {
		if (!api || loginLoading) return;
		setLoginLoading(true);
		setLoginError(null);
		try {
			await api.login(secret);
			if (!mountedRef.current) return;
			setScreen("loading");
			await initialize();
		} catch (error) {
			if (!mountedRef.current) return;
			setLoginError(errorMessage(error, "登录失败，请稍后重试。"));
			setScreen("login");
		} finally {
			if (mountedRef.current) setLoginLoading(false);
		}
	}

	async function handleLogout(): Promise<void> {
		if (!api) return;
		try {
			await api.logout();
		} catch (error) {
			if (!(error instanceof AdminSessionExpiredError)) {
				showNotice(errorMessage(error, "退出管理会话失败。"), "error");
				return;
			}
		}
		if (mountedRef.current) resetForLogin();
	}

	async function refreshSubscription(force = false): Promise<void> {
		if (!api || subscriptionLoading || (!force && !oauth)) return;
		setSubscriptionLoading(true);
		setSubscriptionError(null);
		try {
			const next = await api.getSubscription();
			if (!mountedRef.current) return;
			setSubscription(next);
			setNow(Date.now());
		} catch (error) {
			if (!mountedRef.current) return;
			if (handleSessionFailure(error)) return;
			setSubscriptionError(
				errorMessage(error, "读取订阅与额度失败，请稍后重试。"),
			);
		} finally {
			if (mountedRef.current) setSubscriptionLoading(false);
		}
	}

	async function beginDeviceLogin(): Promise<void> {
		if (!api || deviceRequestInFlightRef.current) return;
		deviceRequestInFlightRef.current = true;
		clearPollTimer();
		setDeviceAuthorization(null);
		setDeviceError(null);
		setDeviceLoading(true);
		try {
			const authorization = await api.startDeviceAuthorization();
			if (!mountedRef.current) return;
			setDeviceAuthorization(authorization);
			scheduleDevicePoll(authorization.state, authorization.interval);
		} catch (error) {
			if (!mountedRef.current) return;
			if (handleSessionFailure(error)) return;
			setDeviceError(errorMessage(error, "无法创建设备登录码。"));
		} finally {
			deviceRequestInFlightRef.current = false;
			if (mountedRef.current) setDeviceLoading(false);
		}
	}

	function scheduleDevicePoll(state: string, seconds: number): void {
		clearPollTimer();
		pollTimerRef.current = window.setTimeout(
			() => void pollDeviceLogin(state),
			Math.max(1, seconds) * 1_000,
		);
	}

	async function pollDeviceLogin(state: string): Promise<void> {
		if (!api || !mountedRef.current) return;
		try {
			const result = await api.pollDeviceAuthorization(state);
			if (!mountedRef.current) return;
			if (result.status === "pending") {
				scheduleDevicePoll(state, result.retryAfter);
				return;
			}
			clearPollTimer();
			setOAuth(result.oauth);
			setSubscription(result.subscription);
			setDeviceAuthorization(null);
			setDeviceError(null);
			showNotice("Codex 登录成功。", "success");
			void refreshSubscription(true);
		} catch (error) {
			if (!mountedRef.current) return;
			if (handleSessionFailure(error)) return;
			setDeviceError(errorMessage(error, "检查设备登录状态失败。"));
		}
	}

	async function removeOAuth(): Promise<void> {
		if (!api || oauthRemoving) return;
		if (!window.confirm("退出当前 Codex 登录？")) return;
		setOAuthRemoving(true);
		try {
			await api.removeOAuth();
			if (!mountedRef.current) return;
			setOAuth(null);
			setSubscription(null);
			setSubscriptionError(null);
			showNotice("已退出 Codex 登录。", "success");
			void beginDeviceLogin();
		} catch (error) {
			if (!handleSessionFailure(error)) {
				showNotice(errorMessage(error, "退出 Codex 登录失败。"), "error");
			}
		} finally {
			if (mountedRef.current) setOAuthRemoving(false);
		}
	}

	async function refreshApiKeys(): Promise<void> {
		if (!api || keysRefreshing) return;
		setKeysRefreshing(true);
		try {
			const state = await api.getState();
			if (!mountedRef.current) return;
			setApiKeys(state.apiKeys);
			setOAuth(state.oauth);
			setSubscription((current) =>
				isSubscriptionInfo(current) && state.oauth
					? current
					: state.subscription,
			);
			showNotice("API Key 列表已刷新。", "success");
		} catch (error) {
			if (!handleSessionFailure(error)) {
				showNotice(errorMessage(error, "刷新 API Key 失败。"), "error");
			}
		} finally {
			if (mountedRef.current) setKeysRefreshing(false);
		}
	}

	async function saveApiKey(value: ClientApiKey): Promise<void> {
		if (!api || !keyEditor || keySaving) return;
		setKeySaving(true);
		try {
			const next =
				keyEditor === "new"
					? await api.createApiKey(value)
					: await api.updateApiKey(keyEditor.name, value);
			if (!mountedRef.current) return;
			setApiKeys(next);
			setKeyEditor(null);
			showNotice("API Key 已保存。", "success");
		} catch (error) {
			if (!handleSessionFailure(error)) {
				showNotice(errorMessage(error, "保存 API Key 失败。"), "error");
			}
		} finally {
			if (mountedRef.current) setKeySaving(false);
		}
	}

	async function deleteApiKey(): Promise<void> {
		if (!api || !pendingDelete || keyDeleting) return;
		setKeyDeleting(true);
		try {
			const next = await api.deleteApiKey(pendingDelete);
			if (!mountedRef.current) return;
			setApiKeys(next);
			setPendingDelete(null);
			showNotice("API Key 已删除。", "success");
		} catch (error) {
			if (!handleSessionFailure(error)) {
				showNotice(errorMessage(error, "删除 API Key 失败。"), "error");
			}
		} finally {
			if (mountedRef.current) setKeyDeleting(false);
		}
	}

	async function copyText(value: string, label: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(value);
			showNotice(`${label}已复制。`, "success");
		} catch {
			showNotice("无法访问剪贴板，请手动复制。", "error");
		}
	}

	function handleSessionFailure(error: unknown): boolean {
		if (!(error instanceof AdminSessionExpiredError)) return false;
		resetForLogin();
		setLoginError(error.message);
		return true;
	}

	function resetForLogin(): void {
		clearPollTimer();
		setScreen("login");
		setOAuth(null);
		setSubscription(null);
		setApiKeys([]);
		setDeviceAuthorization(null);
		setDeviceError(null);
		setKeyEditor(null);
		setPendingDelete(null);
	}

	function clearPollTimer(): void {
		if (pollTimerRef.current === null) return;
		window.clearTimeout(pollTimerRef.current);
		pollTimerRef.current = null;
	}

	function showNotice(text: string, tone: Notice["tone"]): void {
		setNotice({ text, tone });
	}

	if (screen === "invalid-path") return <InvalidPathView />;
	if (screen === "loading") return <LoadingView />;
	if (screen === "login") {
		return (
			<LoginView
				error={loginError}
				loading={loginLoading}
				onSubmit={handleLogin}
			/>
		);
	}

	return (
		<div className="panel-shell">
			<PanelHeader onLogout={() => void handleLogout()} />
			<main className="panel-main">
				<section className="welcome" aria-labelledby="dashboard-title">
					<div>
						<p className="eyebrow">CONTROL CENTER</p>
						<h1 id="dashboard-title">运行控制台</h1>
						<p>集中管理 Codex 登录、订阅额度与客户端访问凭据。</p>
					</div>
					<div className="worker-state">
						<span className="status-dot" aria-hidden="true" />
						Worker 已连接
					</div>
				</section>

				<div className="dashboard-grid">
					<OAuthCard
						deviceAuthorization={deviceAuthorization}
						deviceError={deviceError}
						deviceLoading={deviceLoading}
						oauth={oauth}
						oauthRemoving={oauthRemoving}
						onCopy={(value, label) => void copyText(value, label)}
						onRemove={() => void removeOAuth()}
						onRetry={() => void beginDeviceLogin()}
					/>
					<SubscriptionCard
						error={subscriptionError}
						loading={subscriptionLoading}
						now={now}
						oauth={oauth}
						onRefresh={() => void refreshSubscription()}
						subscription={subscription}
					/>
				</div>

				<ApiKeysCard
					apiKeys={apiKeys}
					loading={keysRefreshing}
					onAdd={() => setKeyEditor("new")}
					onCopy={(value) => void copyText(value, "API Key")}
					onDelete={setPendingDelete}
					onEdit={setKeyEditor}
					onRefresh={() => void refreshApiKeys()}
				/>
			</main>

			{notice ? (
				<StatusToast notice={notice} onClose={() => setNotice(null)} />
			) : null}
			{keyEditor ? (
				<KeyEditorDialog
					entry={keyEditor}
					loading={keySaving}
					onCancel={() => setKeyEditor(null)}
					onSave={(value) => void saveApiKey(value)}
				/>
			) : null}
			{pendingDelete ? (
				<ConfirmDialog
					detail={`“${pendingDelete}”将立即从管理列表中移除。`}
					loading={keyDeleting}
					onCancel={() => setPendingDelete(null)}
					onConfirm={() => void deleteApiKey()}
					title="删除这个 API Key？"
				/>
			) : null}
		</div>
	);
}

function LoadingView() {
	return (
		<div className="auth-shell">
			<div className="loading-card" role="status" aria-live="polite">
				<BrandMark />
				<span className="spinner spinner-large" aria-hidden="true" />
				<h1>正在打开管理面板</h1>
				<p>正在验证会话并读取 Worker 状态…</p>
			</div>
		</div>
	);
}

function InvalidPathView() {
	return (
		<div className="auth-shell">
			<main className="auth-card compact-card">
				<BrandMark />
				<p className="eyebrow">CODEX WORKER</p>
				<h1>管理地址无效</h1>
				<p className="auth-description">
					请通过部署时配置的隐藏管理地址访问此面板。
				</p>
			</main>
		</div>
	);
}

interface LoginViewProps {
	error: string | null;
	loading: boolean;
	onSubmit: (secret: string) => Promise<void>;
}

function LoginView({ error, loading, onSubmit }: LoginViewProps) {
	const [secret, setSecret] = useState("");
	const [visible, setVisible] = useState(false);

	function submit(event: FormEvent<HTMLFormElement>): void {
		event.preventDefault();
		if (!secret || loading) return;
		void onSubmit(secret);
	}

	return (
		<div className="auth-shell">
			<div className="auth-orb auth-orb-one" aria-hidden="true" />
			<div className="auth-orb auth-orb-two" aria-hidden="true" />
			<main className="auth-card">
				<BrandMark />
				<p className="eyebrow">CODEX WORKER</p>
				<h1>欢迎回来</h1>
				<p className="auth-description">
					输入管理密钥，继续管理你的边缘代理服务。
				</p>

				{error ? (
					<div className="inline-alert error-alert" role="alert">
						<Icon name="alert" />
						<span>{error}</span>
					</div>
				) : null}

				<form className="auth-form" onSubmit={submit}>
					<label htmlFor="admin-secret">管理密钥</label>
					<div className="input-with-action">
						<input
							id="admin-secret"
							autoComplete="current-password"
							autoFocus
							disabled={loading}
							maxLength={512}
							onChange={(event) => setSecret(event.target.value)}
							placeholder="输入 ADMIN_SECRET"
							required
							type={visible ? "text" : "password"}
							value={secret}
						/>
						<button
							className="input-action"
							onClick={() => setVisible((value) => !value)}
							type="button"
							aria-label={visible ? "隐藏管理密钥" : "显示管理密钥"}
						>
							<Icon name={visible ? "eye-off" : "eye"} />
						</button>
					</div>
					<button className="button button-primary auth-submit" disabled={loading}>
						{loading ? <span className="spinner" aria-hidden="true" /> : null}
						{loading ? "正在登录…" : "进入管理面板"}
					</button>
				</form>

				<div className="auth-footnote">
					<Icon name="shield" />
					<span>密钥仅发送到当前 Worker，不会保存在浏览器中。</span>
				</div>
			</main>
		</div>
	);
}

function PanelHeader({ onLogout }: { onLogout: () => void }) {
	return (
		<header className="panel-header">
			<a className="brand" href={window.location.pathname} aria-label="Codex Worker 首页">
				<BrandMark small />
				<span>
					<strong>Codex Worker</strong>
					<small>Cloudflare Edge Console</small>
				</span>
			</a>
			<button className="button button-ghost" onClick={onLogout} type="button">
				<Icon name="logout" />
				<span>退出管理</span>
			</button>
		</header>
	);
}

interface OAuthCardProps {
	oauth: OAuthStatus | null;
	oauthRemoving: boolean;
	deviceAuthorization: DeviceAuthorization | null;
	deviceLoading: boolean;
	deviceError: string | null;
	onCopy: (value: string, label: string) => void;
	onRemove: () => void;
	onRetry: () => void;
}

function OAuthCard({
	oauth,
	oauthRemoving,
	deviceAuthorization,
	deviceLoading,
	deviceError,
	onCopy,
	onRemove,
	onRetry,
}: OAuthCardProps) {
	return (
		<section className="card oauth-card" aria-labelledby="oauth-title">
			<CardHeader
				description="用于访问 Codex 上游服务"
				icon="cloud"
				title="Codex OAuth"
			/>

			{oauth ? (
				<div className="oauth-connected">
					<div className="connection-banner">
						<span className="connection-icon" aria-hidden="true">
							<Icon name="check" />
						</span>
						<div>
							<strong>账户已连接</strong>
							<span>OAuth 凭据可用于代理请求</span>
						</div>
					</div>
					<dl className="detail-list">
						<div>
							<dt>账户邮箱</dt>
							<dd>{oauth.email ?? "未提供"}</dd>
						</div>
						<div>
							<dt>凭据过期时间</dt>
							<dd>
								<time dateTime={isoDate(oauth.expiresAt)}>
									{formatDate(oauth.expiresAt)}
								</time>
							</dd>
						</div>
					</dl>
					<button
						className="button button-danger-quiet"
						disabled={oauthRemoving}
						onClick={onRemove}
						type="button"
					>
						{oauthRemoving ? <span className="spinner" aria-hidden="true" /> : null}
						{oauthRemoving ? "正在退出…" : "退出 Codex 登录"}
					</button>
				</div>
			) : (
				<div className="device-flow">
					<div className="connection-banner pending-banner">
						<span className="connection-icon" aria-hidden="true">
							<Icon name="link" />
						</span>
						<div>
							<strong>等待 Codex 登录</strong>
							<span>完成设备验证后会自动连接</span>
						</div>
					</div>

					{deviceLoading ? (
						<div className="center-state" role="status">
							<span className="spinner" aria-hidden="true" />
							<span>正在创建设备登录码…</span>
						</div>
					) : null}

					{deviceAuthorization ? (
						<div className="device-code-panel">
							<p>在 OpenAI 设备验证页输入下面的登录码</p>
							<div className="device-code-row">
								<code>{deviceAuthorization.userCode}</code>
								<button
									className="icon-button"
									onClick={() => onCopy(deviceAuthorization.userCode, "登录码")}
									type="button"
									aria-label="复制设备登录码"
									title="复制登录码"
								>
									<Icon name="copy" />
								</button>
							</div>
							<a
								className="button button-primary"
								href={deviceAuthorization.verificationUri}
								rel="noopener noreferrer"
								target="_blank"
							>
								打开验证页面
								<Icon name="external" />
							</a>
							<small>
								登录码约 {Math.max(1, Math.floor(deviceAuthorization.expiresIn / 60))} 分钟内有效，
								此页面会自动检查结果。
							</small>
						</div>
					) : null}

					{deviceError ? (
						<div className="inline-alert error-alert" role="alert">
							<Icon name="alert" />
							<span>{deviceError}</span>
							<button className="text-button" onClick={onRetry} type="button">
								重新获取
							</button>
						</div>
					) : null}
				</div>
			)}
		</section>
	);
}

interface SubscriptionCardProps {
	oauth: OAuthStatus | null;
	subscription: SubscriptionInfo | SubscriptionMetadata | null;
	loading: boolean;
	error: string | null;
	now: number;
	onRefresh: () => void;
}

function SubscriptionCard({
	oauth,
	subscription,
	loading,
	error,
	now,
	onRefresh,
}: SubscriptionCardProps) {
	const info = isSubscriptionInfo(subscription) ? subscription : null;
	const credits = info?.rateLimitResetCredits;
	const availableCredits = credits?.availableCount ?? null;
	const applicableCredits = credits?.applicableAvailableCount ?? null;
	const showsTimeMarker = Boolean(
		info?.windows.some((window) => quotaTimeState(window, now)),
	);

	return (
		<section className="card subscription-card" aria-labelledby="subscription-title">
			<CardHeader
				action={
					<button
						className="icon-button"
						disabled={!oauth || loading}
						onClick={onRefresh}
						title="刷新订阅与额度"
						type="button"
						aria-label="刷新订阅与额度"
					>
						<Icon name="refresh" spinning={loading} />
					</button>
				}
				description="来自 Codex 的实时订阅与用量"
				icon="meter"
				title="订阅与额度"
			/>

			{!oauth ? (
				<div className="empty-state compact-empty">
					<span className="empty-icon" aria-hidden="true">
						<Icon name="meter" />
					</span>
					<strong>尚未连接 Codex</strong>
					<p>完成设备登录后即可查看套餐与额度窗口。</p>
				</div>
			) : (
				<>
					<div className="summary-grid">
						<SummaryItem label="当前套餐" value={formatPlanType(subscription?.planType)} />
						{validTimestamp(subscription?.subscriptionActiveStart) ? (
							<SummaryItem
								label="订阅开始"
								value={formatDate(subscription.subscriptionActiveStart)}
							/>
						) : null}
						{validTimestamp(subscription?.subscriptionActiveUntil) ? (
							<SummaryItem
								danger={subscription.subscriptionActiveUntil <= now}
								label="订阅到期"
								value={formatDate(subscription.subscriptionActiveUntil)}
							/>
						) : null}
						{availableCredits !== null ? (
							<SummaryItem
								label="额度重置积分"
								value={
									applicableCredits === null
										? String(Math.max(0, availableCredits))
										: `${Math.max(0, availableCredits)} · 当前可用 ${Math.max(0, applicableCredits)}`
								}
							/>
						) : null}
						{validTimestamp(info?.fetchedAt) ? (
							<SummaryItem label="用量更新" value={formatDate(info.fetchedAt)} />
						) : null}
					</div>

					{loading ? (
						<div className="loading-strip" role="status">
							<span className="spinner" aria-hidden="true" />
							正在获取最新用量…
						</div>
					) : null}
					{error ? (
						<div className="inline-alert error-alert" role="alert">
							<Icon name="alert" />
							<span>{error}</span>
						</div>
					) : null}

					{info && info.windows.length > 0 ? (
						<div className="quota-list">
							{info.windows.map((window) => (
								<QuotaCard key={window.id} now={now} window={window} />
							))}
						</div>
					) : !loading && !error ? (
						<p className="muted-message">上游没有返回可展示的额度窗口。</p>
					) : null}

					{showsTimeMarker ? (
						<p className="quota-legend">
							<span className="legend-bar" aria-hidden="true" />
							条形表示剩余额度
							<span className="legend-dot" aria-hidden="true" />
							圆点表示剩余时间
						</p>
					) : null}
				</>
			)}
		</section>
	);
}

function QuotaCard({ window, now }: { window: QuotaWindow; now: number }) {
	const remaining = window.remainingPercent;
	const used = window.usedPercent;
	const hasUsage = remaining !== null && used !== null;
	const timeState = quotaTimeState(window, now);
	const tone = hasUsage
		? remaining <= 10
			? "quota-critical"
			: remaining <= 30
				? "quota-warning"
				: "quota-healthy"
		: "quota-neutral";

	return (
		<article className={`quota-card ${tone}`}>
			<div className="quota-heading">
				<strong>{quotaWindowLabel(window)}</strong>
				{window.limitReached ? <span className="badge badge-danger">额度已用尽</span> : null}
			</div>
			<div className="quota-values">
				<span>{hasUsage ? `剩余 ${Math.round(remaining)}%` : "用量未知"}</span>
				{hasUsage ? <small>已用 {Math.round(used)}%</small> : null}
			</div>
			{timeState ? <p className="quota-time">{timeState.remainingLabel}</p> : null}
			{hasUsage || timeState ? (
				<div
					className="quota-meter"
					role={hasUsage ? "progressbar" : undefined}
					aria-valuemax={hasUsage ? 100 : undefined}
					aria-valuemin={hasUsage ? 0 : undefined}
					aria-valuenow={hasUsage ? Math.round(remaining) : undefined}
					aria-valuetext={
						hasUsage
							? `${quotaWindowLabel(window)}剩余额度 ${Math.round(remaining)}%`
							: undefined
					}
					title={timeState?.title}
				>
					{hasUsage ? (
						<progress aria-hidden="true" max={100} value={clampPercent(remaining)} />
					) : null}
					{timeState ? (
						<input
							aria-hidden="true"
							className="quota-time-dot"
							disabled
							max={100}
							min={0}
							readOnly
							tabIndex={-1}
							type="range"
							value={clampPercent(timeState.percent)}
						/>
					) : null}
				</div>
			) : null}
			<p className="quota-reset">
				重置时间：
				{validTimestamp(window.resetAt) ? (
					<time dateTime={isoDate(window.resetAt)}>{formatDate(window.resetAt)}</time>
				) : (
					"未知"
				)}
			</p>
		</article>
	);
}

interface ApiKeysCardProps {
	apiKeys: ClientApiKey[];
	loading: boolean;
	onAdd: () => void;
	onCopy: (value: string) => void;
	onDelete: (name: string) => void;
	onEdit: (entry: ClientApiKey) => void;
	onRefresh: () => void;
}

function ApiKeysCard({
	apiKeys,
	loading,
	onAdd,
	onCopy,
	onDelete,
	onEdit,
	onRefresh,
}: ApiKeysCardProps) {
	const [visibleKeys, setVisibleKeys] = useState<Set<string>>(() => new Set());

	function toggleVisible(name: string): void {
		setVisibleKeys((current) => {
			const next = new Set(current);
			if (next.has(name)) next.delete(name);
			else next.add(name);
			return next;
		});
	}

	return (
		<section className="card keys-card" aria-labelledby="keys-title">
			<CardHeader
				action={
					<div className="card-actions">
						<button
							className="icon-button"
							disabled={loading}
							onClick={onRefresh}
							title="刷新 API Key"
							type="button"
							aria-label="刷新 API Key"
						>
							<Icon name="refresh" spinning={loading} />
						</button>
						<button className="button button-primary" onClick={onAdd} type="button">
							<Icon name="plus" />
							添加 API Key
						</button>
					</div>
				}
				description={`${apiKeys.length} 个客户端访问凭据`}
				icon="key"
				title="API Keys"
			/>

			{apiKeys.length === 0 ? (
				<div className="empty-state">
					<span className="empty-icon" aria-hidden="true">
						<Icon name="key" />
					</span>
					<strong>尚未配置 API Key</strong>
					<p>添加一个 Key 后，客户端才能访问兼容 API。</p>
					<button className="button button-secondary" onClick={onAdd} type="button">
						<Icon name="plus" />
						添加第一个 Key
					</button>
				</div>
			) : (
				<div className="table-wrap">
					<table>
						<thead>
							<tr>
								<th scope="col">名称</th>
								<th scope="col">Key</th>
								<th scope="col">状态</th>
								<th scope="col" className="actions-column">
									操作
								</th>
							</tr>
						</thead>
						<tbody>
							{apiKeys.map((entry) => {
								const visible = visibleKeys.has(entry.name);
								return (
									<tr key={entry.name}>
										<td data-label="名称">
											<strong>{entry.name}</strong>
										</td>
										<td data-label="Key">
											<div className="key-value-cell">
												<code>{visible ? entry.key : maskApiKey(entry.key)}</code>
												<button
													className="icon-button small-icon-button"
													onClick={() => toggleVisible(entry.name)}
													title={visible ? "隐藏 Key" : "显示 Key"}
													type="button"
													aria-label={visible ? `隐藏 ${entry.name}` : `显示 ${entry.name}`}
												>
													<Icon name={visible ? "eye-off" : "eye"} />
												</button>
												<button
													className="icon-button small-icon-button"
													onClick={() => onCopy(entry.key)}
													title="复制 Key"
													type="button"
													aria-label={`复制 ${entry.name}`}
												>
													<Icon name="copy" />
												</button>
											</div>
										</td>
										<td data-label="状态">
											<span className={`badge ${entry.enabled ? "badge-success" : "badge-muted"}`}>
												<span className="badge-dot" aria-hidden="true" />
												{entry.enabled ? "已启用" : "已停用"}
											</span>
										</td>
										<td data-label="操作">
											<div className="row-actions">
												<button
													className="icon-button"
													onClick={() => onEdit(entry)}
													title="编辑"
													type="button"
													aria-label={`编辑 ${entry.name}`}
												>
													<Icon name="edit" />
												</button>
												<button
													className="icon-button danger-icon-button"
													onClick={() => onDelete(entry.name)}
													title="删除"
													type="button"
													aria-label={`删除 ${entry.name}`}
												>
													<Icon name="trash" />
												</button>
											</div>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
		</section>
	);
}

interface KeyEditorDialogProps {
	entry: Exclude<EditableKey, null>;
	loading: boolean;
	onCancel: () => void;
	onSave: (value: ClientApiKey) => void;
}

function KeyEditorDialog({ entry, loading, onCancel, onSave }: KeyEditorDialogProps) {
	const existing = entry === "new" ? null : entry;
	const [name, setName] = useState(existing?.name ?? "");
	const [key, setKey] = useState(existing?.key ?? generateApiKey());
	const [enabled, setEnabled] = useState(existing?.enabled ?? true);
	const [visible, setVisible] = useState(false);

	useEffect(() => {
		function onKeyDown(event: KeyboardEvent): void {
			if (event.key === "Escape" && !loading) onCancel();
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [loading, onCancel]);

	function submit(event: FormEvent<HTMLFormElement>): void {
		event.preventDefault();
		if (loading) return;
		onSave({ name, key, enabled });
	}

	return (
		<div
			className="modal-backdrop"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget && !loading) onCancel();
			}}
		>
			<section
				aria-labelledby="key-editor-title"
				aria-modal="true"
				className="modal"
				role="dialog"
			>
				<div className="modal-header">
					<div>
						<p className="eyebrow">CLIENT CREDENTIAL</p>
						<h2 id="key-editor-title">{existing ? "编辑 API Key" : "添加 API Key"}</h2>
					</div>
					<button
						className="icon-button"
						disabled={loading}
						onClick={onCancel}
						type="button"
						aria-label="关闭"
					>
						<Icon name="close" />
					</button>
				</div>
				<form className="editor-form" onSubmit={submit}>
					<label htmlFor="key-name">
						<span>名称</span>
						<input
							id="key-name"
							autoFocus
							disabled={loading}
							maxLength={100}
							onChange={(event) => setName(event.target.value)}
							placeholder="例如：my-laptop"
							required
							type="text"
							value={name}
						/>
					</label>
					<label htmlFor="key-value">
						<span>Key</span>
						<div className="input-with-action key-input">
							<input
								id="key-value"
								autoComplete="off"
								disabled={loading}
								maxLength={67}
								onChange={(event) => setKey(event.target.value)}
								pattern="sk-[a-z0-9]{64}"
								required
								spellCheck={false}
								type={visible ? "text" : "password"}
								value={key}
							/>
							<button
								className="input-action"
								onClick={() => setVisible((value) => !value)}
								type="button"
								aria-label={visible ? "隐藏 Key" : "显示 Key"}
							>
								<Icon name={visible ? "eye-off" : "eye"} />
							</button>
						</div>
					</label>
					<div className="editor-tools">
						<button
							className="button button-secondary"
							disabled={loading}
							onClick={() => setKey(generateApiKey())}
							type="button"
						>
							<Icon name="spark" />
							安全生成
						</button>
						<label className="switch-row">
							<span>
								<strong>启用此 Key</strong>
								<small>停用后客户端请求会立即被拒绝</small>
							</span>
							<input
								checked={enabled}
								disabled={loading}
								onChange={(event) => setEnabled(event.target.checked)}
								type="checkbox"
							/>
						</label>
					</div>
					<div className="modal-actions">
						<button
							className="button button-secondary"
							disabled={loading}
							onClick={onCancel}
							type="button"
						>
							取消
						</button>
						<button className="button button-primary" disabled={loading} type="submit">
							{loading ? <span className="spinner" aria-hidden="true" /> : null}
							{loading ? "正在保存…" : "保存 API Key"}
						</button>
					</div>
				</form>
			</section>
		</div>
	);
}

interface ConfirmDialogProps {
	title: string;
	detail: string;
	loading: boolean;
	onCancel: () => void;
	onConfirm: () => void;
}

function ConfirmDialog({
	title,
	detail,
	loading,
	onCancel,
	onConfirm,
}: ConfirmDialogProps) {
	return (
		<div className="modal-backdrop">
			<section
				aria-labelledby="confirm-title"
				aria-modal="true"
				className="modal confirm-modal"
				role="alertdialog"
			>
				<span className="confirm-icon" aria-hidden="true">
					<Icon name="trash" />
				</span>
				<h2 id="confirm-title">{title}</h2>
				<p>{detail}</p>
				<p className="confirm-warning">删除后无法恢复，但可以随时创建新的 Key。</p>
				<div className="modal-actions">
					<button className="button button-secondary" disabled={loading} onClick={onCancel} type="button">
						取消
					</button>
					<button className="button button-danger" disabled={loading} onClick={onConfirm} type="button">
						{loading ? <span className="spinner" aria-hidden="true" /> : null}
						{loading ? "正在删除…" : "确认删除"}
					</button>
				</div>
			</section>
		</div>
	);
}

function StatusToast({ notice, onClose }: { notice: Notice; onClose: () => void }) {
	return (
		<div className={`status-toast ${notice.tone}`} role="status" aria-live="polite">
			<span className="toast-icon" aria-hidden="true">
				<Icon name={notice.tone === "success" ? "check" : "alert"} />
			</span>
			<p>{notice.text}</p>
			<button onClick={onClose} type="button" aria-label="关闭通知">
				<Icon name="close" />
			</button>
		</div>
	);
}

function CardHeader({
	title,
	description,
	icon,
	action,
}: {
	title: string;
	description: string;
	icon: IconName;
	action?: ReactNode;
}) {
	return (
		<div className="card-header">
			<div className="card-heading">
				<span className="card-icon" aria-hidden="true">
					<Icon name={icon} />
				</span>
				<div>
					<h2 id={`${title === "API Keys" ? "keys" : title === "Codex OAuth" ? "oauth" : "subscription"}-title`}>
						{title}
					</h2>
					<p>{description}</p>
				</div>
			</div>
			{action}
		</div>
	);
}

function SummaryItem({
	label,
	value,
	danger = false,
}: {
	label: string;
	value: string;
	danger?: boolean;
}) {
	return (
		<div className="summary-item">
			<span>{label}</span>
			<strong className={danger ? "danger-text" : undefined}>{value}</strong>
		</div>
	);
}

function BrandMark({ small = false }: { small?: boolean }) {
	return (
		<span className={`brand-mark${small ? " brand-mark-small" : ""}`} aria-hidden="true">
			<svg viewBox="0 0 32 32" fill="none">
				<path d="M16 4.5 25.96 10v12L16 27.5 6.04 22V10L16 4.5Z" />
				<path d="m11.1 13.08 4.9-2.7 4.9 2.7v5.84l-4.9 2.7-4.9-2.7v-5.84Z" />
				<path d="M16 10.38v11.24M11.1 13.08l4.9 2.75 4.9-2.75" />
			</svg>
		</span>
	);
}

type IconName =
	| "alert"
	| "check"
	| "close"
	| "cloud"
	| "copy"
	| "edit"
	| "external"
	| "eye"
	| "eye-off"
	| "key"
	| "link"
	| "logout"
	| "meter"
	| "plus"
	| "refresh"
	| "shield"
	| "spark"
	| "trash";

function Icon({ name, spinning = false }: { name: IconName; spinning?: boolean }) {
	return (
		<svg
			aria-hidden="true"
			className={`icon${spinning ? " icon-spinning" : ""}`}
			fill="none"
			stroke="currentColor"
			strokeLinecap="round"
			strokeLinejoin="round"
			strokeWidth="1.8"
			viewBox="0 0 24 24"
		>
			{iconPaths(name)}
		</svg>
	);
}

function iconPaths(name: IconName): ReactNode {
	switch (name) {
		case "alert":
			return <><path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.75 3h15.7a2 2 0 0 0 1.75-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></>;
		case "check":
			return <path d="m5 12 4.2 4.2L19 6.5" />;
		case "close":
			return <><path d="m6 6 12 12" /><path d="M18 6 6 18" /></>;
		case "cloud":
			return <path d="M17.5 19H7a5 5 0 0 1-.9-9.92A7 7 0 0 1 19.4 11 4 4 0 0 1 17.5 19Z" />;
		case "copy":
			return <><rect height="13" rx="2" width="13" x="8" y="8" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>;
		case "edit":
			return <><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z" /></>;
		case "external":
			return <><path d="M15 3h6v6" /><path d="m10 14 11-11" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></>;
		case "eye":
			return <><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" /><circle cx="12" cy="12" r="2.5" /></>;
		case "eye-off":
			return <><path d="m3 3 18 18" /><path d="M10.6 6.15A10.6 10.6 0 0 1 12 6c6.5 0 10 6 10 6a16.8 16.8 0 0 1-3 3.8" /><path d="M6.6 6.6C3.5 8.4 2 12 2 12s3.5 6 10 6a10.7 10.7 0 0 0 3.4-.55" /></>;
		case "key":
			return <><circle cx="7.5" cy="15.5" r="4.5" /><path d="m11 12 9-9" /><path d="m15 8 3 3" /><path d="m17 6 3 3" /></>;
		case "link":
			return <><path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1" /><path d="M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1" /></>;
		case "logout":
			return <><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /></>;
		case "meter":
			return <><path d="M4 19a8 8 0 1 1 16 0" /><path d="m12 15 4-5" /><path d="M5 19h14" /></>;
		case "plus":
			return <><path d="M12 5v14" /><path d="M5 12h14" /></>;
		case "refresh":
			return <><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></>;
		case "shield":
			return <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />;
		case "spark":
			return <><path d="m12 3 1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2Z" /><path d="m19 14 .8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8Z" /><path d="m5 14 .7 1.8 1.8.7-1.8.7L5 19l-.7-1.8-1.8-.7 1.8-.7Z" /></>;
		case "trash":
			return <><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="m19 6-1 15H6L5 6" /><path d="M10 11v5M14 11v5" /></>;
	}
}

function managementBasePath(pathname: string): string | null {
	if (!MANAGEMENT_PATH_PATTERN.test(pathname)) return null;
	return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

function errorMessage(error: unknown, fallback: string): string {
	return error instanceof AdminApiError || error instanceof Error
		? error.message
		: fallback;
}

function isSubscriptionInfo(
	value: SubscriptionInfo | SubscriptionMetadata | null,
): value is SubscriptionInfo {
	return value !== null && "windows" in value;
}

function validTimestamp(value: number | null | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isoDate(value: number): string {
	return new Date(value).toISOString();
}

function formatDate(value: number): string {
	return new Intl.DateTimeFormat("zh-CN", {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(value));
}

function formatPlanType(value: string | null | undefined): string {
	const normalized = value?.trim().toLowerCase() ?? "";
	switch (normalized) {
		case "pro":
			return "Pro";
		case "prolite":
		case "pro-lite":
		case "pro_lite":
			return "Pro Lite";
		case "plus":
			return "Plus";
		case "team":
			return "Team";
		case "free":
			return "Free";
		default:
			return value || "未知";
	}
}

function quotaWindowLabel(window: QuotaWindow): string {
	const labels: Record<QuotaWindow["kind"], string> = {
		five_hour: "5 小时额度",
		weekly: "7 天额度",
		monthly: "月度额度",
		primary: "主要额度",
		secondary: "次要额度",
	};
	const name = window.category === "code_review" ? "代码审查" : window.name || "Codex";
	return `${name} · ${labels[window.kind]}`;
}

function quotaTimeState(
	window: QuotaWindow,
	now: number,
): { percent: number; remainingLabel: string; title: string } | null {
	if (
		!validTimestamp(window.resetAt) ||
		window.limitWindowSeconds === null ||
		window.limitWindowSeconds <= 0
	) {
		return null;
	}
	const duration = window.limitWindowSeconds * 1_000;
	const remaining = Math.max(0, Math.min(duration, window.resetAt - now));
	const percent = (remaining / duration) * 100;
	const remainingLabel =
		window.resetAt <= now
			? "已到重置时间"
			: `剩余 ${formatRemainingDuration(remaining)}`;
	return {
		percent,
		remainingLabel,
		title: `剩余时间 ${Math.round(percent)}%（${remainingLabel}）`,
	};
}

function formatRemainingDuration(milliseconds: number): string {
	const totalMinutes = Math.max(0, Math.ceil(milliseconds / 60_000));
	if (totalMinutes === 0) return "不足 1 分钟";
	const days = Math.floor(totalMinutes / 1_440);
	const hours = Math.floor((totalMinutes % 1_440) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return `${days} 天${hours > 0 ? ` ${hours} 小时` : ""}`;
	if (hours > 0) return `${hours} 小时${minutes > 0 ? ` ${minutes} 分钟` : ""}`;
	return `${minutes} 分钟`;
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

function maskApiKey(value: string): string {
	return `${value.slice(0, 5)}••••••••••••${value.slice(-8)}`;
}

function generateApiKey(): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	let value = "";
	const bytes = new Uint8Array(96);
	while (value.length < 64) {
		crypto.getRandomValues(bytes);
		for (const byte of bytes) {
			if (byte < 252) value += alphabet[byte % alphabet.length];
			if (value.length === 64) break;
		}
	}
	return `sk-${value}`;
}

export default App;
