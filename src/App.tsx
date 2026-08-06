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
const MIN_API_KEY_LENGTH = 11;
const MAX_API_KEY_LENGTH = 512;
const GENERATED_API_KEY_LENGTH = 20;
const API_KEY_INPUT_PATTERN = String.raw`(?=.*[A-Za-z])(?=.*[0-9])(?=.*[^A-Za-z0-9\s]).{${MIN_API_KEY_LENGTH},${MAX_API_KEY_LENGTH}}`;

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
	const [keysToggling, setKeysToggling] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
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
	const keyTogglingRef = useRef<Set<string>>(new Set());
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

	async function toggleApiKey(entry: ClientApiKey): Promise<void> {
		if (
			!api ||
			keysRefreshing ||
			keyTogglingRef.current.size > 0
		) {
			return;
		}

		const enabled = !entry.enabled;
		const pending = new Set(keyTogglingRef.current);
		pending.add(entry.name);
		keyTogglingRef.current = pending;
		setKeysToggling(pending);
		setApiKeys((current) =>
			current.map((candidate) =>
				candidate.name === entry.name ? { ...candidate, enabled } : candidate,
			),
		);

		try {
			const next = await api.updateApiKey(entry.name, { ...entry, enabled });
			if (!mountedRef.current) return;
			setApiKeys(next);
			showNotice(`API Key 已${enabled ? "启用" : "停用"}。`, "success");
		} catch (error) {
			if (!mountedRef.current) return;
			if (!handleSessionFailure(error)) {
				setApiKeys((current) =>
					current.map((candidate) =>
						candidate.name === entry.name
							? { ...candidate, enabled: entry.enabled }
							: candidate,
					),
				);
				showNotice(errorMessage(error, "切换 API Key 状态失败。"), "error");
			}
		} finally {
			const remaining = new Set(keyTogglingRef.current);
			remaining.delete(entry.name);
			keyTogglingRef.current = remaining;
			if (mountedRef.current) setKeysToggling(remaining);
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
		keyTogglingRef.current = new Set();
		setKeysToggling(new Set());
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
					<h1 id="dashboard-title">管理</h1>
				</section>

				<AccountCard
					deviceAuthorization={deviceAuthorization}
					deviceError={deviceError}
					deviceLoading={deviceLoading}
					error={subscriptionError}
					loading={subscriptionLoading}
					now={now}
					oauth={oauth}
					oauthRemoving={oauthRemoving}
					onCopy={(value, label) => void copyText(value, label)}
					onRefresh={() => void refreshSubscription()}
					onRemove={() => void removeOAuth()}
					onRetry={() => void beginDeviceLogin()}
					subscription={subscription}
				/>

				<ApiKeysCard
					apiKeys={apiKeys}
					loading={keysRefreshing}
					onAdd={() => setKeyEditor("new")}
					onCopy={(value) => void copyText(value, "API Key")}
					onDelete={setPendingDelete}
					onEdit={setKeyEditor}
					onRefresh={() => void refreshApiKeys()}
					onToggle={(entry) => void toggleApiKey(entry)}
					togglingKeys={keysToggling}
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
					loading={keyDeleting}
					onCancel={() => setPendingDelete(null)}
					onConfirm={() => void deleteApiKey()}
					title={`删除“${pendingDelete}”？`}
				/>
			) : null}
		</div>
	);
}

function LoadingView() {
	return (
		<div className="auth-shell">
			<div className="loading-card" role="status" aria-live="polite">
				<span className="spinner" aria-hidden="true" />
				<span>正在加载…</span>
			</div>
		</div>
	);
}

function InvalidPathView() {
	return (
		<div className="auth-shell">
			<main className="auth-card compact-card">
				<h1>地址无效</h1>
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
			<main className="auth-card">
				{error ? (
					<div className="inline-alert error-alert" role="alert">
						<Icon name="alert" />
						<span>{error}</span>
					</div>
				) : null}

				<form className="auth-form" onSubmit={submit}>
					<div className="input-with-action">
						<input
							id="admin-secret"
							aria-label="管理密码"
							autoComplete="current-password"
							autoFocus
							disabled={loading}
							maxLength={512}
							onChange={(event) => setSecret(event.target.value)}
							placeholder="输入管理密码"
							required
							type={visible ? "text" : "password"}
							value={secret}
						/>
						<button
							className="input-action"
							onClick={() => setVisible((value) => !value)}
							type="button"
							aria-label={visible ? "隐藏管理密码" : "显示管理密码"}
						>
							<Icon name={visible ? "eye-off" : "eye"} />
						</button>
					</div>
					<button className="button button-primary auth-submit" disabled={loading}>
						{loading ? <span className="spinner" aria-hidden="true" /> : null}
						{loading ? "登录中…" : "登录"}
					</button>
				</form>
			</main>
		</div>
	);
}

function PanelHeader({ onLogout }: { onLogout: () => void }) {
	return (
		<header className="panel-header">
			<a className="brand" href={window.location.pathname} aria-label="Codex Worker 首页">
				<strong>Codex Worker</strong>
			</a>
			<button
				aria-label="退出"
				className="button button-ghost header-action"
				onClick={onLogout}
				title="退出"
				type="button"
			>
				<Icon name="logout" />
			</button>
		</header>
	);
}

interface AccountCardProps {
	oauth: OAuthStatus | null;
	oauthRemoving: boolean;
	subscription: SubscriptionInfo | SubscriptionMetadata | null;
	loading: boolean;
	error: string | null;
	now: number;
	deviceAuthorization: DeviceAuthorization | null;
	deviceLoading: boolean;
	deviceError: string | null;
	onCopy: (value: string, label: string) => void;
	onRefresh: () => void;
	onRemove: () => void;
	onRetry: () => void;
}

function AccountCard({
	oauth,
	oauthRemoving,
	subscription,
	loading,
	error,
	now,
	deviceAuthorization,
	deviceLoading,
	deviceError,
	onCopy,
	onRefresh,
	onRemove,
	onRetry,
}: AccountCardProps) {
	const info = isSubscriptionInfo(subscription) ? subscription : null;
	const credits = info?.rateLimitResetCredits;
	const availableCredits = credits?.availableCount ?? null;
	const applicableCredits = credits?.applicableAvailableCount ?? null;
	const resetCredits =
		availableCredits === null
			? "暂无数据"
			: applicableCredits === null
				? String(Math.max(0, availableCredits))
				: `${Math.max(0, availableCredits)} · 可用 ${Math.max(0, applicableCredits)}`;

	return (
		<section className="card account-card" aria-labelledby="account-title">
			<CardHeader
				id="account-title"
				action={
					oauth ? (
						<div className="account-header-actions">
							<button
								className="button button-secondary account-header-button"
								disabled={loading}
								onClick={onRefresh}
								type="button"
							>
								<Icon name="refresh" spinning={loading} />
								{loading ? "刷新中…" : "刷新"}
							</button>
							<button
								className="button button-danger-quiet account-header-button"
								disabled={oauthRemoving}
								onClick={onRemove}
								type="button"
							>
								{oauthRemoving ? (
									<span className="spinner" aria-hidden="true" />
								) : (
									<Icon name="logout" />
								)}
								{oauthRemoving ? "退出中…" : "退出登录"}
							</button>
						</div>
					) : undefined
				}
				title="Codex 账户"
			/>

			{oauth ? (
				<div className="account-body account-body-connected">
					<div className="account-profile">
						<div className="account-identity-row">
							<strong className="account-email">{oauth.email ?? "未提供邮箱"}</strong>
							<span className="plan-badge">{formatPlanType(subscription?.planType)}</span>
							<span className="plan-info">
								<button
									aria-describedby="account-plan-details"
									aria-label="查看套餐详情"
									className="plan-info-button"
									type="button"
								>
									<Icon name="info" />
								</button>
								<span className="plan-tooltip" id="account-plan-details" role="tooltip">
									<strong>套餐详情</strong>
									<span className="plan-tooltip-row">
										<span>开始时间</span>
										<b>
											{validTimestamp(subscription?.subscriptionActiveStart)
												? formatDate(subscription.subscriptionActiveStart)
												: "暂无数据"}
										</b>
									</span>
									<span className="plan-tooltip-row">
										<span>到期时间</span>
										<b
											className={
												validTimestamp(subscription?.subscriptionActiveUntil) &&
												subscription.subscriptionActiveUntil <= now
													? "danger-text"
													: undefined
											}
										>
											{validTimestamp(subscription?.subscriptionActiveUntil)
												? formatDate(subscription.subscriptionActiveUntil)
												: "暂无数据"}
										</b>
									</span>
									<span className="plan-tooltip-row">
										<span>重置积分</span>
										<b>{resetCredits}</b>
									</span>
									<span className="plan-tooltip-row">
										<span>用量更新时间</span>
										<b>
											{validTimestamp(info?.fetchedAt)
												? formatDate(info.fetchedAt)
												: "暂无数据"}
										</b>
									</span>
								</span>
							</span>
						</div>
						<p className="token-expiry">
							Token 到期时间：
							{validTimestamp(oauth.expiresAt) ? (
								<time dateTime={isoDate(oauth.expiresAt)}>{formatDate(oauth.expiresAt)}</time>
							) : (
								"未知"
							)}
						</p>
					</div>

					<div className="account-usage">
						{loading ? (
							<div className="loading-strip" role="status">
								<span className="spinner" aria-hidden="true" />
								正在刷新…
							</div>
						) : null}
						{error ? (
							<div className="inline-alert error-alert" role="alert">
								<Icon name="alert" />
								<span>{error}</span>
							</div>
						) : null}
						{info && info.windows.length > 0 ? (
							<QuotaRings now={now} windows={info.windows} />
						) : !loading && !error ? (
							<p className="muted-message">暂无额度数据</p>
						) : null}
					</div>
				</div>
			) : (
				<div className="account-body account-body-disconnected">
					<div className="account-device">
						{deviceLoading ? (
							<div className="center-state" role="status">
								<span className="spinner" aria-hidden="true" />
								<span>正在获取登录码…</span>
							</div>
						) : null}
						{deviceAuthorization ? (
							<>
								<div className="device-code-inline">
									<code>{deviceAuthorization.userCode}</code>
									<button
										className="button button-secondary device-copy-button"
										onClick={() => onCopy(deviceAuthorization.userCode, "登录码")}
										type="button"
									>
										<Icon name="copy" />
										复制
									</button>
								</div>
								<small className="device-code-expiry">
									设备码将在 {Math.max(1, Math.floor(deviceAuthorization.expiresIn / 60))} 分钟后失效
								</small>
							</>
						) : null}
						{deviceError ? (
							<div className="inline-alert error-alert" role="alert">
								<Icon name="alert" />
								<span>{deviceError}</span>
							</div>
						) : null}
					</div>
					<div className="account-login-action">
						{deviceAuthorization ? (
							<a
								className="button button-primary"
								href={deviceAuthorization.verificationUri}
								rel="noopener noreferrer"
								target="_blank"
							>
								打开登录页面
								<Icon name="external" />
							</a>
						) : deviceError ? (
							<button className="button button-secondary" onClick={onRetry} type="button">
								<Icon name="refresh" />
								重新获取设备码
							</button>
						) : (
							<button className="button button-primary" disabled type="button">
								<span className="spinner" aria-hidden="true" />
								正在准备登录页面…
							</button>
						)}
					</div>
				</div>
			)}
		</section>
	);
}

function QuotaRings({ now, windows }: { now: number; windows: QuotaWindow[] }) {
	const codex =
		windows.find(
			(window) => window.category === "codex" && window.kind === "five_hour",
		) ?? windows.find((window) => window.category === "codex") ?? null;
	const spark =
		windows.find(
			(window) =>
				window.category === "additional" &&
				window.name.trim().toLowerCase() === "gpt-5.3-codex-spark",
		) ?? null;
	const codexPercent = quotaRemainingPercent(codex);
	const sparkPercent = quotaRemainingPercent(spark);
	const codexTimePercent = quotaRemainingTimePercent(codex, now);
	const sparkTimePercent = quotaRemainingTimePercent(spark, now);
	const otherWindows = windows.filter(
		(window) => window !== codex && window !== spark,
	);

	return (
		<>
			<div className="quota-rings">
				<div
					aria-label={`Codex ${quotaRemainingLabel(codex)}，${quotaRemainingTimeLabel(codex, now)}；GPT-5.3-Codex-Spark ${quotaRemainingLabel(spark)}，${quotaRemainingTimeLabel(spark, now)}`}
					className="quota-ring-chart"
					role="img"
				>
					<svg aria-hidden="true" viewBox="0 0 140 140">
						<circle className="quota-ring-track" cx="70" cy="70" r="54" strokeWidth="17" />
						{codexPercent !== null ? (
							<circle
								className="quota-ring-value quota-ring-codex"
								cx="70"
								cy="70"
								pathLength="100"
								r="54"
								strokeDasharray="100 100"
								strokeDashoffset={100 - codexPercent}
								strokeWidth="17"
								transform="rotate(-90 70 70)"
							/>
						) : null}
						<circle className="quota-ring-track" cx="70" cy="70" r="32" strokeWidth="17" />
						{sparkPercent !== null ? (
							<circle
								className="quota-ring-value quota-ring-spark"
								cx="70"
								cy="70"
								pathLength="100"
								r="32"
								strokeDasharray="100 100"
								strokeDashoffset={100 - sparkPercent}
								strokeWidth="17"
								transform="rotate(-90 70 70)"
							/>
						) : null}
						{codexTimePercent !== null ? (
							<circle
								className="quota-time-marker"
								cx="70"
								cy="16"
								r="5"
								transform={`rotate(${codexTimePercent * 3.6} 70 70)`}
							/>
						) : null}
						{sparkTimePercent !== null ? (
							<circle
								className="quota-time-marker"
								cx="70"
								cy="38"
								r="4.75"
								transform={`rotate(${sparkTimePercent * 3.6} 70 70)`}
							/>
						) : null}
					</svg>
				</div>

				<div className="quota-ring-legend">
					<QuotaRingLegend label="Codex" ring="codex" window={codex} />
					<QuotaRingLegend
						label="GPT-5.3-Codex-Spark"
						ring="spark"
						window={spark}
					/>
				</div>
			</div>

			{otherWindows.length > 0 ? (
				<div className="quota-extra-list">
					{otherWindows.map((window) => (
						<div className="quota-extra-item" key={window.id}>
							<span>{quotaWindowLabel(window)}</span>
							<strong className={window.limitReached ? "danger-text" : undefined}>
								{quotaRemainingLabel(window)}
							</strong>
						</div>
					))}
				</div>
			) : null}
		</>
	);
}

function QuotaRingLegend({
	label,
	ring,
	window,
}: {
	label: string;
	ring: "codex" | "spark";
	window: QuotaWindow | null;
}) {
	return (
		<div className="quota-ring-legend-item">
			<span className={`quota-ring-swatch quota-ring-swatch-${ring}`} aria-hidden="true" />
			<strong>{label}</strong>
			<span>{quotaCompactValue(window)}</span>
		</div>
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
	onToggle: (entry: ClientApiKey) => void;
	togglingKeys: ReadonlySet<string>;
}

function ApiKeysCard({
	apiKeys,
	loading,
	onAdd,
	onCopy,
	onDelete,
	onEdit,
	onRefresh,
	onToggle,
	togglingKeys,
}: ApiKeysCardProps) {
	const [visibleKeys, setVisibleKeys] = useState<Set<string>>(() => new Set());
	const busy = loading || togglingKeys.size > 0;

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
				id="keys-title"
				action={
					<div className="card-actions">
						<button
							className="icon-button"
							disabled={busy}
							onClick={onRefresh}
							title="刷新 API Key"
							type="button"
							aria-label="刷新 API Key"
						>
							<Icon name="refresh" spinning={loading} />
						</button>
						<button
							className="button button-primary"
							disabled={busy}
							onClick={onAdd}
							type="button"
						>
							<Icon name="plus" />
							添加
						</button>
					</div>
				}
				title={`API Keys${apiKeys.length > 0 ? ` · ${apiKeys.length}` : ""}`}
			/>

			{apiKeys.length === 0 ? (
				<div className="empty-state">
					<strong>暂无 API Key</strong>
					<button
						className="button button-secondary"
						disabled={busy}
						onClick={onAdd}
						type="button"
					>
						<Icon name="plus" />
						添加
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
								const toggling = togglingKeys.has(entry.name);
								return (
									<tr key={entry.name}>
										<td data-label="名称">
											<strong title={entry.name}>{entry.name}</strong>
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
											<label
												className="key-status-switch"
												title={toggling ? "正在更新状态…" : entry.enabled ? "停用" : "启用"}
											>
												<input
													aria-busy={toggling || undefined}
													aria-label={`${entry.enabled ? "停用" : "启用"} ${entry.name}`}
													checked={entry.enabled}
													className="switch-control"
													disabled={busy}
													onChange={() => onToggle(entry)}
													type="checkbox"
												/>
											</label>
										</td>
										<td data-label="操作">
											<div className="row-actions">
												<button
													className="icon-button"
													disabled={busy}
													onClick={() => onEdit(entry)}
													title="编辑"
													type="button"
													aria-label={`编辑 ${entry.name}`}
												>
													<Icon name="edit" />
												</button>
												<button
													className="icon-button danger-icon-button"
													disabled={busy}
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
	const [key, setKey] = useState(() => existing?.key ?? generateApiKey());
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
					<h2 id="key-editor-title">{existing ? "编辑 API Key" : "添加 API Key"}</h2>
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
								maxLength={MAX_API_KEY_LENGTH}
								minLength={MIN_API_KEY_LENGTH}
								onChange={(event) => setKey(event.target.value)}
								pattern={API_KEY_INPUT_PATTERN}
								required
								spellCheck={false}
								title="总长度超过 10 位，并同时包含字母、数字和符号"
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
							重新生成
						</button>
						<label className="switch-row">
							<strong>启用</strong>
							<input
								checked={enabled}
								className="switch-control"
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
							{loading ? "保存中…" : "保存"}
						</button>
					</div>
				</form>
			</section>
		</div>
	);
}

interface ConfirmDialogProps {
	title: string;
	loading: boolean;
	onCancel: () => void;
	onConfirm: () => void;
}

function ConfirmDialog({
	title,
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
				<h2 id="confirm-title">{title}</h2>
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
	id,
	title,
	action,
}: {
	id: string;
	title: string;
	action?: ReactNode;
}) {
	return (
		<div className="card-header">
			<h2 id={id}>{title}</h2>
			{action}
		</div>
	);
}

type IconName =
	| "alert"
	| "check"
	| "close"
	| "copy"
	| "edit"
	| "external"
	| "eye"
	| "eye-off"
	| "info"
	| "logout"
	| "plus"
	| "refresh"
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
		case "info":
			return <><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" /></>;
		case "logout":
			return <><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /></>;
		case "plus":
			return <><path d="M12 5v14" /><path d="M5 12h14" /></>;
		case "refresh":
			return <><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></>;
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
	const name = window.category === "code_review" ? "代码审查" : window.name || "Codex";
	return `${name} · ${quotaWindowPeriodLabel(window.kind)}`;
}

function quotaWindowPeriodLabel(kind: QuotaWindow["kind"]): string {
	const labels: Record<QuotaWindow["kind"], string> = {
		five_hour: "5 小时",
		weekly: "7 天",
		monthly: "月度",
		primary: "主要额度",
		secondary: "次要额度",
	};
	return labels[kind];
}

function quotaRemainingPercent(window: QuotaWindow | null): number | null {
	return window?.remainingPercent === null || window?.remainingPercent === undefined
		? null
		: clampPercent(window.remainingPercent);
}

function quotaRemainingLabel(window: QuotaWindow | null): string {
	const percent = quotaRemainingPercent(window);
	return percent === null ? "暂无数据" : `剩余 ${Math.round(percent)}%`;
}

function quotaRemainingTimePercent(
	window: QuotaWindow | null,
	now: number,
): number | null {
	if (
		!window ||
		!validTimestamp(window.resetAt) ||
		window.limitWindowSeconds === null ||
		window.limitWindowSeconds <= 0
	) {
		return null;
	}
	const duration = window.limitWindowSeconds * 1_000;
	return clampPercent(((window.resetAt - now) / duration) * 100);
}

function quotaRemainingTimeLabel(window: QuotaWindow | null, now: number): string {
	const percent = quotaRemainingTimePercent(window, now);
	return percent === null ? "时间暂无数据" : `剩余时间 ${Math.round(percent)}%`;
}

function quotaCompactValue(window: QuotaWindow | null): string {
	const percent = quotaRemainingPercent(window);
	const value = percent === null ? "—" : `${Math.round(percent)}%`;
	return window && validTimestamp(window.resetAt)
		? `${value} · ${formatCompactDate(window.resetAt)}`
		: value;
}

function formatCompactDate(value: number): string {
	return new Intl.DateTimeFormat("zh-CN", {
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(new Date(value));
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

function maskApiKey(value: string): string {
	return `${value.slice(0, 3)}••••••••••••${value.slice(-4)}`;
}

function generateApiKey(): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	const bytes = new Uint8Array(32);
	for (;;) {
		let value = "";
		while (value.length < GENERATED_API_KEY_LENGTH) {
			crypto.getRandomValues(bytes);
			for (const byte of bytes) {
				if (byte < 252) value += alphabet[byte % alphabet.length];
				if (value.length === GENERATED_API_KEY_LENGTH) break;
			}
		}
		if (/[a-z]/.test(value) && /[0-9]/.test(value)) return `sk-${value}`;
	}
}

export default App;
