import { createServerLogger } from "@/lib/logger/server";

type VerificationEmail = {
  email: string;
  code: string;
  purpose: "signup";
  expiresInMinutes: number;
};

type SendCloudResponse =
  | {
      result: true;
      statusCode: number;
      message: string;
      info?: unknown;
    }
  | {
      result: false;
      statusCode?: number;
      message?: string;
      errors?: unknown;
    };

const emailLogger = createServerLogger("email");

function getRequiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

async function sendWithSendCloud(payload: VerificationEmail) {
  const apiUser = getRequiredEnv("SENDCLOUD_API_USER");
  const apiKey = getRequiredEnv("SENDCLOUD_API_KEY");
  const from = getRequiredEnv("SENDCLOUD_FROM");
  const fromName = process.env.SENDCLOUD_FROM_NAME ?? "Open Debate";
  const endpoint = process.env.SENDCLOUD_API_ENDPOINT ?? "https://api.sendcloud.net/apiv2/mail/send";

  const subject =
    process.env.SENDCLOUD_SUBJECT ?? "你的验证码";

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.5;color:#122033">
      <h2 style="margin:0 0 12px 0">验证码</h2>
      <p style="margin:0 0 12px 0">你的验证码是：</p>
      <div style="font-size:28px;font-weight:800;letter-spacing:4px;margin:0 0 12px 0">${payload.code}</div>
      <p style="margin:0 0 12px 0;color:#526277">有效期 ${payload.expiresInMinutes} 分钟，请勿泄露。</p>
      <hr style="border:none;border-top:1px solid #d7dfeb;margin:16px 0" />
      <div style="font-size:12px;color:#526277">如果不是你本人操作，请忽略此邮件。</div>
    </div>
  `.trim();

  const form = new URLSearchParams();
  form.set("apiUser", apiUser);
  form.set("apiKey", apiKey);
  form.set("from", from);
  form.set("fromName", fromName);
  form.set("to", payload.email);
  form.set("subject", subject);
  form.set("html", html);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString()
  });

  let data: SendCloudResponse | null = null;
  try {
    data = (await response.json()) as SendCloudResponse;
  } catch {
    // ignore
  }

  if (!response.ok) {
    throw new Error(`SendCloud HTTP ${response.status}: ${JSON.stringify(data)}`);
  }
  if (!data || (data as { result?: boolean }).result !== true) {
    throw new Error(`SendCloud send failed: ${JSON.stringify(data)}`);
  }
}

export async function sendVerificationEmail(payload: VerificationEmail) {
  const delivery = (process.env.EMAIL_DELIVERY ?? "console").toLowerCase();

  if (delivery === "sendcloud") {
    await sendWithSendCloud(payload);
    return;
  }

  emailLogger.info("verification email console delivery", {
    purpose: payload.purpose,
    to: payload.email,
    code: payload.code,
    expiresInMinutes: payload.expiresInMinutes
  });
}
