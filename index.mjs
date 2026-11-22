/**
 * 卡扣AI (kakouai.com) daily check-in for Magpie App.
 * Standalone Android distribution: import this file with the App's native
 * local-plugin importer. No npm or sibling-file dependencies.
 *
 * Two endpoints, both Bearer-authenticated with the web-login JWT:
 *   - Check-in: POST /api/v1/client/checkin
 *   - Balance:  GET  /api/v1/user/profile
 *
 * Sign-in: paste the JWT the kakouai.com web app keeps in
 * localStorage.auth_token after a browser login.
 */

const API = "https://api.kakouai.com/api/v1"
const PROVIDER = "kakou"

// jwtExp reads a JWT's exp claim (epoch seconds → epoch ms), 0 when the
// token is not a JWT or carries no readable exp. Uses atob (web runtime),
// not Buffer (Node-only, absent in the App's webview).
function jwtExp(token) {
  const parts = token.split(".")
  if (parts.length !== 3) return 0
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/")
    const payload = JSON.parse(atob(b64))
    const exp = Number(payload.exp)
    return isFinite(exp) && exp > 0 ? exp * 1000 : 0
  } catch (e) {
    return 0
  }
}

// tokenOf reads the credential from an auth object.
const tokenOf = (auth) => {
  const raw =
    auth?.type === "api" ? auth.key : auth?.type === "oauth" ? auth.access ?? auth.refresh : undefined
  const token = typeof raw === "string" ? raw.trim() : ""
  return token && /^[\x21-\x7e]+$/.test(token) ? token : ""
}

// isAuthError reads a vendor answer as "the token was refused".
const isAuthError = (status, body) =>
  status === 401 || body?.code === "INVALID_TOKEN" || body?.code === "UNAUTHORIZED"

async function apiGet(path, token) {
  try {
    const res = await fetch(`${API}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const body = await res.json().catch(() => null)
    return { status: res.status, body }
  } catch (e) {
    return { status: 0, body: null, error: e?.message || "network error" }
  }
}

async function apiPost(path, token) {
  try {
    const res = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    })
    const body = await res.json().catch(() => null)
    return { status: res.status, body }
  } catch (e) {
    return { status: 0, body: null, error: e?.message || "network error" }
  }
}

// Magpie treats exported functions as plugins: export this factory only.
export const KakouPlugin = async () => ({
  config: async (config) => {
    config.provider ??= {};
    config.provider[PROVIDER] ??= {
      name: "卡扣AI 签到",
      npm: "@ai-sdk/openai-compatible",
      api: API,
      models: {},
    };
  },

  auth: {
    provider: PROVIDER,
    icon: "https://kakouai.com/api/v1/settings/images/site_logo?v=522fbe642cf3",

    methods: [{
      type: "api",
      label: "卡扣令牌",
      placeholder: "粘贴卡扣AI 登录令牌",
      prompts: [{
        key: "token",
        type: "password",
        message: "卡扣AI 访问令牌（浏览器登录 kakouai.com 后，从 localStorage.auth_token 获取）",
        validate: () => null,
      }],
      async authorize(inputs = {}) {
        const typed = typeof inputs.token === "string" ? inputs.token.trim() : ""
        if (!typed) return { type: "failed", error: "请粘贴卡扣AI 登录令牌" }
        if (!/^[\x21-\x7e]+$/.test(typed)) {
          return { type: "failed", error: "令牌含空格或换行，请重新粘贴" }
        }
        const exp = jwtExp(typed)
        if (exp > 0 && exp <= Date.now()) {
          return { type: "failed", error: "登录令牌已过期，请重新登录后粘贴新令牌" }
        }
        return { type: "success", key: typed }
      },
    }],

    async loader(getAuth) {
      let got
      try { got = await getAuth() } catch (e) { return {} }
      const token = tokenOf(got)
      if (!token) return {}
      return { apiKey: token, baseURL: API }
    },

    async checkin(getAuth) {
      let auth
      try { auth = await getAuth() } catch (e) {
        return { outcome: "failed", message: "读取登录信息失败" }
      }
      const token = tokenOf(auth)
      if (!token) return { outcome: "failed", message: "没有登录信息，请先登录" }

      const { status, body, error } = await apiPost("/client/checkin", token)
      if (error) return { outcome: "failed", message: `签到请求失败：${error}` }

      if (isAuthError(status, body)) {
        return { outcome: "failed", message: "登录已过期，请重新登录" }
      }

      const code = body?.code

      if (code === "claimed_success") {
        const amount = Number(body?.amount) || 0
        const nextAt = body?.next_checkin_at ? Date.parse(body.next_checkin_at) : NaN
        const message = amount > 0 ? `签到成功，获得 ${amount} 额度` : "签到成功"
        return {
          outcome: "claimed",
          credit: amount,
          message,
          until: Number.isFinite(nextAt) && nextAt > Date.now() ? nextAt : undefined,
        }
      }

      if (code === "CHECKIN_USER_ALREADY_CLAIMED") {
        return { outcome: "done", message: "今日已签到" }
      }
      if (code === "CHECKIN_CLIENT_ALREADY_CLAIMED") {
        return { outcome: "done", message: "本设备今日已签到" }
      }

      if (code === "CHECKIN_RATE_LIMITED") {
        const retryAfter = Number(body?.retry_after_seconds) || 0
        return {
          outcome: "failed",
          message: "签到请求被限流，请稍后再试",
          until: retryAfter > 0 ? Date.now() + retryAfter * 1000 : undefined,
        }
      }

      return {
        outcome: "failed",
        message: body?.message || `签到失败（HTTP ${status}）`,
      }
    },

    async usage(getAuth) {
      let auth
      try { auth = await getAuth() } catch (e) {
        return { error: "读取登录信息失败", signIn: "" }
      }
      const token = tokenOf(auth)
      if (!token) return { error: "没有登录信息，请先登录", signIn: "" }

      const { status, body, error } = await apiGet("/user/profile", token)
      if (error) return { error: `用量查询失败：${error}`, signIn: "" }

      if (isAuthError(status, body)) {
        return { error: "登录已过期，请重新登录", signIn: "expired" }
      }

      const profile = body?.data && typeof body.data === "object" ? body.data : body
      const balance = Number(profile?.balance)
      if (!isFinite(balance)) {
        return { error: "未读取到余额信息", signIn: "" }
      }

      return {
        user: profile?.username || "",
        windows: [{ name: "余额", balance, unit: "元" }],
      }
    },
  },
});
