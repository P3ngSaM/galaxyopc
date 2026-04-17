export function asString(value: unknown, fallback = ""): string {
  return value !== undefined && value !== null ? String(value) : fallback;
}

export function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export function detectMailHost(email: string, type: "smtp" | "imap"): string {
  const domain = email.split("@")[1] || "";
  const map: Record<string, { smtp: string; imap: string }> = {
    "163.com": { smtp: "smtp.163.com", imap: "imap.163.com" },
    "126.com": { smtp: "smtp.126.com", imap: "imap.126.com" },
    "qq.com": { smtp: "smtp.qq.com", imap: "imap.qq.com" },
    "foxmail.com": { smtp: "smtp.qq.com", imap: "imap.qq.com" },
    "gmail.com": { smtp: "smtp.gmail.com", imap: "imap.gmail.com" },
    "outlook.com": { smtp: "smtp.office365.com", imap: "outlook.office365.com" },
    "hotmail.com": { smtp: "smtp.office365.com", imap: "outlook.office365.com" },
  };
  return map[domain]?.[type] || `${type}.${domain}`;
}
