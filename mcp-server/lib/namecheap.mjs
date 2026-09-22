import { XMLParser } from "fast-xml-parser";

export class NamecheapError extends Error {
  constructor(message) {
    super(message);
    this.name = "NamecheapError";
  }
}

export const RECORD_TYPES = [
  "A",
  "AAAA",
  "ALIAS",
  "CAA",
  "CNAME",
  "MX",
  "MXE",
  "NS",
  "TXT",
  "URL",
  "URL301",
  "FRAME",
];

const RECORD_TYPE_SET = new Set(RECORD_TYPES);

const MULTI_PART_TLDS = new Set([
  "co.uk", "org.uk", "me.uk", "net.uk", "ac.uk", "gov.uk",
  "co.nz", "net.nz", "org.nz", "ac.nz",
  "com.au", "net.au", "org.au", "asn.au", "id.au",
  "com.br", "net.br", "org.br",
  "co.jp", "ne.jp", "or.jp",
  "com.mx", "co.za", "org.za", "net.za", "web.za",
  "com.sg", "com.hk", "com.tw", "com.tr", "co.kr", "com.cn",
  "com.ar", "com.co", "co.il", "org.il", "com.my", "com.ph",
  "com.vn", "co.th", "com.ua", "com.ng", "com.pk", "com.pe",
  "co.id", "com.bd", "com.eg", "com.sa", "com.ec", "com.do",
  "com.uy", "co.in", "net.in", "org.in", "ind.in", "firm.in", "gen.in",
  "com.es", "nom.es", "org.es", "co.at", "or.at",
  "com.pl", "net.pl", "com.pt", "co.ke", "com.gh",
]);

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const HOST_NAME_RE = /^(?:\*|@|(?:_?[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?)(?:\._?[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?)*)$/i;
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  removeNSPrefix: true,
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (tagName) => ["Error", "Warning", "Domain", "host", "Host", "DomainCheckResult", "Nameserver"].includes(tagName),
});

function trim(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function redact(text, secrets) {
  let output = String(text ?? "");
  const values = [...new Set((secrets || []).filter((secret) => typeof secret === "string" && secret.length >= 4))];
  values.sort((left, right) => right.length - left.length);
  for (const secret of values) output = output.split(secret).join("[redacted]");
  return output.replace(/([?&]ApiKey=)[^&\s]+/gi, "$1[redacted]");
}

export function attr(node, name) {
  if (!node || typeof node !== "object") return "";
  const value = node[`@_${name}`];
  return value == null ? "" : String(value);
}

export function textContent(node) {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") return String(node);
  if (typeof node === "object" && "#text" in node) return String(node["#text"]);
  return "";
}

export function asNodes(value) {
  if (value == null || value === "") return [];
  const list = Array.isArray(value) ? value : [value];
  return list.filter((item) => item != null && item !== "");
}

function isIpv4(value) {
  if (!IPV4_RE.test(value)) return false;
  return value.split(".").every((part) => String(Number(part)) === part || part === "0");
}

function isNonPublicIpv4(ip) {
  const [a, b] = ip.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

export function resolveApiBase(env) {
  const raw = trim(env.NAMECHEAP_API_BASE) || "https://api.namecheap.com/xml.response";
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new NamecheapError("NAMECHEAP_API_BASE is not a valid URL.");
  }
  if (url.protocol !== "https:") throw new NamecheapError("NAMECHEAP_API_BASE must use https.");
  if (url.hostname !== "api.namecheap.com" && url.hostname !== "api.sandbox.namecheap.com") {
    throw new NamecheapError("NAMECHEAP_API_BASE host must be api.namecheap.com or api.sandbox.namecheap.com.");
  }
  if (url.username || url.password || url.search) {
    throw new NamecheapError("NAMECHEAP_API_BASE must not include credentials or a query string.");
  }
  return `${url.origin}${url.pathname}`;
}

export function inspectConfig(env = process.env) {
  const apiUser = trim(env.NAMECHEAP_API_USER);
  const apiKey = trim(env.NAMECHEAP_API_KEY);
  const clientIp = trim(env.NAMECHEAP_CLIENT_IP);
  const username = trim(env.NAMECHEAP_USERNAME) || apiUser;
  const missing = [];
  if (!apiUser) missing.push("NAMECHEAP_API_USER");
  if (!apiKey) missing.push("NAMECHEAP_API_KEY");
  if (!clientIp) missing.push("NAMECHEAP_CLIENT_IP");

  const blockers = [];
  if (missing.length) {
    blockers.push(
      `Missing variables: ${missing.join(", ")}. Set them in Cursor under Plugins → Configure. Do not paste the API key into chat.`,
    );
  }
  if (apiUser.length > 20) blockers.push("NAMECHEAP_API_USER must be at most 20 characters.");
  if (apiKey.length > 50) blockers.push("NAMECHEAP_API_KEY must be at most 50 characters.");
  if (username.length > 20) blockers.push("NAMECHEAP_USERNAME must be at most 20 characters.");
  if (clientIp && !isIpv4(clientIp)) {
    blockers.push("NAMECHEAP_CLIENT_IP must be a public IPv4 address. Namecheap accepts only IPv4 for ClientIp (max 15 characters).");
  }

  let apiBase = "https://api.namecheap.com/xml.response";
  try {
    apiBase = resolveApiBase(env);
  } catch (error) {
    blockers.push(error.message);
  }

  const ipWarning = clientIp && isIpv4(clientIp) && isNonPublicIpv4(clientIp)
    ? "Configured ClientIp looks private, shared, or loopback. Whitelist the public IPv4 that Namecheap sees, not a LAN address."
    : null;

  return {
    apiUser,
    apiKey,
    clientIp,
    username,
    missing,
    apiBase,
    blockers,
    ipWarning,
    ready: blockers.length === 0,
  };
}

export function requireConfig(env = process.env) {
  const config = inspectConfig(env);
  if (!config.ready) throw new NamecheapError(config.blockers.join("\n"));
  return config;
}

export function splitRegisteredDomain(input) {
  const domain = String(input ?? "").trim().replace(/\.$/, "").toLowerCase();
  if (!domain) throw new NamecheapError("Domain name is required.");
  if (/[^\x00-\x7F]/.test(domain)) {
    throw new NamecheapError(`Use the ASCII or punycode form of "${input}", not Unicode labels.`);
  }
  if (!DOMAIN_RE.test(domain)) throw new NamecheapError(`"${domain}" is not a domain name like example.com.`);

  const labels = domain.split(".");
  const lastTwo = labels.slice(-2).join(".");
  const tldSize = labels.length >= 3 && MULTI_PART_TLDS.has(lastTwo) ? 2 : 1;
  if (labels.length !== tldSize + 1) {
    const sld = labels[labels.length - tldSize - 1];
    const tld = labels.slice(-tldSize).join(".");
    throw new NamecheapError(`"${domain}" looks like a hostname. DNS tools need the registered domain (${sld}.${tld}).`);
  }
  return { domain, sld: labels[0], tld: labels.slice(1).join(".") };
}

export function normalizeDomainList(input) {
  const domains = String(input ?? "")
    .split(",")
    .map((domain) => domain.trim().replace(/\.$/, "").toLowerCase())
    .filter(Boolean);
  if (!domains.length) throw new NamecheapError("Provide at least one domain, separated by commas.");
  if (domains.length > 50) throw new NamecheapError("Namecheap domain checks accept at most 50 names per call.");
  for (const domain of domains) {
    if (/[^\x00-\x7F]/.test(domain) || !DOMAIN_RE.test(domain)) {
      throw new NamecheapError(`"${domain}" is not a domain name like example.com. Use ASCII or punycode.`);
    }
  }
  return domains;
}

export function normalizeHost(input, { requireMxPref = true } = {}) {
  const name = String(input?.name ?? "").trim();
  const type = String(input?.type ?? "").trim().toUpperCase();
  const address = String(input?.address ?? "").trim();
  if (!HOST_NAME_RE.test(name)) {
    throw new NamecheapError(`Invalid DNS host name "${name}". Use @ for the apex, * for a wildcard, or a hostname label.`);
  }
  if (!RECORD_TYPE_SET.has(type)) {
    throw new NamecheapError(`Invalid record type "${type}". Expected one of: ${RECORD_TYPES.join(", ")}.`);
  }
  if (!address || /[\u0000-\u001F\u007F]/.test(address)) {
    throw new NamecheapError(`DNS address for ${name} ${type} is empty or contains control characters.`);
  }
  if (address.length > 2000) throw new NamecheapError(`DNS address for ${name} ${type} is too long.`);

  let ttl = null;
  if (input?.ttl != null && input.ttl !== "") {
    ttl = Number(input.ttl);
    if (!Number.isInteger(ttl) || ttl < 60 || ttl > 60000) {
      throw new NamecheapError(`TTL for ${name} ${type} must be an integer from 60 to 60000.`);
    }
  }

  let mxPref = null;
  if (input?.mxPref != null && input.mxPref !== "") {
    mxPref = Number(input.mxPref);
    if (!Number.isInteger(mxPref) || mxPref < 0 || mxPref > 65535) {
      throw new NamecheapError(`MXPref for ${name} must be an integer from 0 to 65535.`);
    }
  }
  if (requireMxPref && (type === "MX" || type === "MXE") && mxPref == null) {
    throw new NamecheapError(`${type} record ${name} requires mxPref.`);
  }

  return { name, type, address, ttl, mxPref };
}

export function coerceHostForWrite(host) {
  const ttlNumber = Number(host.ttl);
  const mxNumber = Number(host.mxPref);
  return normalizeHost({
    name: host.name,
    type: host.type,
    address: host.address,
    ttl: Number.isInteger(ttlNumber) && ttlNumber >= 60 && ttlNumber <= 60000 ? ttlNumber : undefined,
    mxPref: Number.isInteger(mxNumber) && mxNumber >= 0 && mxNumber <= 65535 ? mxNumber : undefined,
  }, { requireMxPref: true });
}

export function applyHostEdit(existing, edit) {
  const matchName = String(edit.name ?? "").trim();
  const matchType = String(edit.type ?? "").trim().toUpperCase();
  const hasAddress = edit.address != null && String(edit.address).trim() !== "";
  const matchAddress = hasAddress ? String(edit.address).trim() : null;
  const matches = existing.filter((host) => {
    if (host.name.toLowerCase() !== matchName.toLowerCase()) return false;
    if (host.type.toUpperCase() !== matchType) return false;
    if (matchAddress != null && host.address.trim() !== matchAddress) return false;
    return true;
  });

  if (matches.length > 1) {
    const listed = matches.map((host) => `${host.name} ${host.type} ${host.address}`).join("\n");
    throw new NamecheapError(
      `Matched ${matches.length} DNS records for ${matchName} ${matchType}. Pass address to choose one. No changes were sent.\n${listed}`,
    );
  }

  if (edit.remove) {
    if (matches.length === 0) {
      throw new NamecheapError(`No ${matchType} record named ${matchName} to delete. No changes were sent.`);
    }
    const next = existing.filter((host) => host !== matches[0]);
    if (next.length === 0) {
      throw new NamecheapError("Refusing to delete the last DNS record. No changes were sent.");
    }
    return { action: "delete", next };
  }

  if (!edit.record) throw new NamecheapError("record is required unless remove is true. No changes were sent.");
  const record = normalizeHost(edit.record);
  if (matches.length === 0) return { action: "add", next: [...existing, record] };
  return { action: "replace", next: existing.map((host) => (host === matches[0] ? record : host)) };
}

export function hostsToParams(hosts, { sld, tld, emailType }) {
  if (!Array.isArray(hosts) || hosts.length === 0) throw new NamecheapError("At least one DNS record is required.");
  if (hosts.length > 100) throw new NamecheapError("Refusing to send more than 100 host records in one setHosts call.");
  const params = { SLD: sld, TLD: tld };
  if (emailType) params.EmailType = String(emailType);
  hosts.forEach((host, index) => {
    const normalized = normalizeHost(host);
    const n = index + 1;
    params[`HostName${n}`] = normalized.name;
    params[`RecordType${n}`] = normalized.type;
    params[`Address${n}`] = normalized.address;
    if (normalized.ttl != null) params[`TTL${n}`] = String(normalized.ttl);
    if (normalized.mxPref != null) params[`MXPref${n}`] = String(normalized.mxPref);
  });
  return params;
}

function messageNodes(container, childName) {
  if (!container || typeof container !== "object") return [];
  return asNodes(container[childName])
    .map((node) => ({
      number: attr(node, "Number") || null,
      message: textContent(node),
    }))
    .filter((item) => item.message || item.number);
}

export function parseApiXml(xmlText) {
  const raw = String(xmlText ?? "");
  if (!raw.includes("<ApiResponse")) {
    throw new NamecheapError("Namecheap returned a response that is not an ApiResponse document.");
  }
  let parsed;
  try {
    parsed = parser.parse(raw);
  } catch {
    throw new NamecheapError("Could not parse the Namecheap XML response.");
  }
  const root = parsed?.ApiResponse;
  if (!root || typeof root !== "object") {
    throw new NamecheapError("Namecheap returned a response that is not an ApiResponse document.");
  }
  return {
    status: attr(root, "Status").toUpperCase(),
    errors: messageNodes(root.Errors, "Error"),
    warnings: messageNodes(root.Warnings, "Warning"),
    command: textContent(root.RequestedCommand),
    commandResponse: root.CommandResponse && typeof root.CommandResponse === "object" ? root.CommandResponse : {},
  };
}

export async function namecheapCall(command, params = {}, options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const config = requireConfig(env);
  const body = new URLSearchParams();
  body.set("ApiUser", config.apiUser);
  body.set("ApiKey", config.apiKey);
  body.set("UserName", config.username);
  body.set("ClientIp", config.clientIp);
  body.set("Command", command);
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === "") continue;
    body.set(key, String(value));
  }

  let response;
  try {
    response = await fetchImpl(config.apiBase, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/xml, text/xml",
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new NamecheapError("Namecheap API request timed out after 30 seconds.");
    }
    const detail = redact([error?.message, error?.cause?.message].filter(Boolean).join(": "), [config.apiKey]);
    throw new NamecheapError(`Could not reach the Namecheap API. ${detail}`.trim());
  }

  const xmlText = await response.text();
  let parsed;
  try {
    parsed = parseApiXml(xmlText);
  } catch (error) {
    const message = error instanceof NamecheapError ? error.message : "Could not parse the Namecheap API response.";
    throw new NamecheapError(`${message} (HTTP ${response.status}).`);
  }

  if (parsed.status !== "OK" || parsed.errors.length > 0) {
    const detail = parsed.errors
      .map((item) => `${item.number ? `[${item.number}] ` : ""}${item.message || "Unknown error"}`)
      .join("\n");
    throw new NamecheapError(
      redact(
        detail
          ? `Namecheap API error for ${command}:\n${detail}`
          : `Namecheap API returned status ${parsed.status || "ERROR"} for ${command}.`,
        [config.apiKey],
      ),
    );
  }
  return parsed;
}

export function extractHosts(commandResponse) {
  const result = commandResponse?.DomainDNSGetHostsResult;
  if (!result || typeof result !== "object") {
    throw new NamecheapError("Namecheap getHosts response did not include host records.");
  }
  const nodes = [...asNodes(result.host), ...asNodes(result.Host)];
  return {
    domain: attr(result, "Domain") || null,
    isUsingOurDns: attr(result, "IsUsingOurDNS").toLowerCase(),
    emailType: attr(result, "EmailType"),
    hosts: nodes.map((node) => ({
      hostId: attr(node, "HostId") || attr(node, "HostID") || null,
      name: attr(node, "Name"),
      type: attr(node, "Type").toUpperCase(),
      address: attr(node, "Address"),
      mxPref: attr(node, "MXPref"),
      ttl: attr(node, "TTL"),
    })),
  };
}

function jsonBlock(value) {
  return ["", "```json", JSON.stringify(value, null, 2), "```"].join("\n");
}

export function formatDomainList(commandResponse, { page, pageSize }) {
  const result = commandResponse.DomainGetListResult || {};
  const domains = asNodes(result.Domain).map((domain) => ({
    id: attr(domain, "ID"),
    name: attr(domain, "Name"),
    created: attr(domain, "Created"),
    expires: attr(domain, "Expires"),
    isExpired: attr(domain, "IsExpired"),
    isLocked: attr(domain, "IsLocked"),
    autoRenew: attr(domain, "AutoRenew"),
    whoisGuard: attr(domain, "WhoisGuard"),
    isPremium: attr(domain, "IsPremium"),
    isOurDns: attr(domain, "IsOurDNS"),
  }));
  const paging = {
    totalItems: textContent(commandResponse.Paging?.TotalItems),
    currentPage: textContent(commandResponse.Paging?.CurrentPage) || String(page),
    pageSize: textContent(commandResponse.Paging?.PageSize) || String(pageSize),
  };
  const lines = [
    `Namecheap domain list (page ${paging.currentPage}, page size ${paging.pageSize}).`,
    paging.totalItems
      ? `Total domains: ${paging.totalItems}. This page has ${domains.length}.`
      : `This page has ${domains.length} domain${domains.length === 1 ? "" : "s"}.`,
    "",
  ];
  if (!domains.length) lines.push("No domains on this page.");
  for (const domain of domains) {
    lines.push(
      `- ${domain.name} — expires ${domain.expires || "unknown"}, auto-renew ${domain.autoRenew || "unknown"}, WhoisGuard ${domain.whoisGuard || "unknown"}, Namecheap DNS ${domain.isOurDns || "unknown"}, expired ${domain.isExpired || "unknown"}`,
    );
  }
  lines.push(jsonBlock({ paging, domains }));
  return lines.join("\n");
}

export function formatCheck(commandResponse) {
  const results = asNodes(commandResponse.DomainCheckResult).map((domain) => ({
    domain: attr(domain, "Domain"),
    available: attr(domain, "Available"),
    isPremium: attr(domain, "IsPremiumName"),
    premiumRegistrationPrice: attr(domain, "PremiumRegistrationPrice"),
    premiumRenewalPrice: attr(domain, "PremiumRenewalPrice"),
    description: attr(domain, "Description"),
    errorNo: attr(domain, "ErrorNo"),
  }));
  const lines = ["Namecheap availability check. This does not register or renew anything.", ""];
  if (!results.length) lines.push("Namecheap returned no domain check results.");
  for (const result of results) {
    const premium = result.isPremium.toLowerCase() === "true"
      ? `, premium registration price ${result.premiumRegistrationPrice || "unknown"}`
      : "";
    lines.push(`- ${result.domain}: available ${result.available || "unknown"}, premium ${result.isPremium || "unknown"}${premium}`);
  }
  lines.push(jsonBlock({ results }));
  return lines.join("\n");
}

export function formatDomainInfo(commandResponse) {
  const result = commandResponse.DomainGetInfoResult || {};
  const details = result.DomainDetails || {};
  const dns = result.DnsDetails || {};
  const whois = result.Whoisguard;
  const whoisGuardEnabled = typeof whois === "string" ? whois : attr(whois, "Enabled") || textContent(whois);
  const nameservers = asNodes(dns.Nameserver).map(textContent).filter(Boolean);
  const summary = {
    status: attr(result, "Status"),
    id: attr(result, "ID"),
    domain: attr(result, "DomainName"),
    owner: attr(result, "OwnerName"),
    isOwner: attr(result, "IsOwner"),
    isPremium: attr(result, "IsPremium"),
    created: textContent(details.CreatedDate),
    expires: textContent(details.ExpiredDate),
    whoisGuardEnabled,
    dnsProvider: attr(dns, "ProviderType"),
    isUsingOurDns: attr(dns, "IsUsingOurDNS"),
    nameservers,
  };
  const lines = [
    `Domain ${summary.domain || "(unknown)"} — status ${summary.status || "unknown"}.`,
    `Created ${summary.created || "unknown"}, expires ${summary.expires || "unknown"}.`,
    `WhoisGuard: ${summary.whoisGuardEnabled || "unknown"}.`,
    `DNS provider: ${summary.dnsProvider || "unknown"} (Namecheap DNS: ${summary.isUsingOurDns || "unknown"}).`,
  ];
  if (nameservers.length) lines.push(`Nameservers: ${nameservers.join(", ")}`);
  if (summary.isUsingOurDns.toLowerCase() === "false") {
    lines.push("Host-record edits work only when this domain uses Namecheap DNS.");
  }
  lines.push(jsonBlock(summary));
  return lines.join("\n");
}

export function formatHosts(commandResponse) {
  const zone = extractHosts(commandResponse);
  const lines = [
    `DNS hosts for ${zone.domain || "the domain"}.`,
    `Namecheap DNS: ${zone.isUsingOurDns || "unknown"}. EmailType: ${zone.emailType || "(none reported)"}.`,
    `${zone.hosts.length} record${zone.hosts.length === 1 ? "" : "s"}.`,
    "",
  ];
  if (!zone.hosts.length) lines.push("No host records were returned.");
  for (const host of zone.hosts) {
    const ttl = host.ttl ? `, TTL ${host.ttl}` : "";
    const mx = host.mxPref ? `, MXPref ${host.mxPref}` : "";
    lines.push(`- ${host.name} ${host.type} ${host.address}${ttl}${mx}`);
  }
  if (zone.isUsingOurDns === "false") {
    lines.push("", "This domain is not using Namecheap DNS, so setHosts cannot edit these records.");
  }
  lines.push("", "setHosts replaces every record. To change one, read this list and send the complete set back.");
  lines.push(jsonBlock(zone));
  return lines.join("\n");
}

export function formatBalances(commandResponse) {
  const result = commandResponse.UserGetBalancesResult || {};
  const balances = {
    currency: attr(result, "Currency"),
    availableBalance: attr(result, "AvailableBalance"),
    accountBalance: attr(result, "AccountBalance"),
    earnedAmount: attr(result, "EarnedAmount"),
    withdrawableAmount: attr(result, "WithdrawableAmount"),
    fundsRequiredForAutoRenew: attr(result, "FundsRequiredForAutoRenew"),
  };
  const lines = [
    `Namecheap balance: ${balances.availableBalance || "unknown"} ${balances.currency || ""} available.`.trim(),
    `Account balance ${balances.accountBalance || "unknown"}. Funds required for auto-renew: ${balances.fundsRequiredForAutoRenew || "unknown"}.`,
  ];
  lines.push(jsonBlock(balances));
  return lines.join("\n");
}

export function formatAuthStatus({ config, pingError, balancesText }) {
  const lines = [
    "Namecheap credential check. The API key is never shown.",
    `API user present: ${config.apiUser ? "yes" : "no"}`,
    `API key present: ${config.apiKey ? "yes" : "no"}`,
    `UserName: ${config.username || "(missing)"}`,
    `Configured ClientIp: ${config.clientIp || "(missing)"}`,
    "ClientIp must be the public IPv4 whitelisted in Namecheap API Access. This server does not auto-detect an address.",
  ];
  if (config.blockers.length) lines.push("", ...config.blockers);
  if (config.ipWarning) lines.push("", config.ipWarning);
  if (balancesText) {
    lines.push("", "Balance request succeeded. Credentials and ClientIp were accepted.", "", balancesText);
  } else if (pingError) {
    lines.push(
      "",
      `Balance request failed: ${pingError}`,
      "If the error mentions ClientIP or whitelist, add this public IPv4 under Namecheap → Profile → Tools → API Access → Whitelisted IPs, then update NAMECHEAP_CLIENT_IP.",
    );
  }
  return redact(lines.join("\n"), [config.apiKey]);
}

export function formatDnsWrite({ domain, action, previous, next, emailType }) {
  const lines = [
    `Namecheap setHosts succeeded for ${domain} (${action}).`,
    "This call replaced the entire host list. Records that were not sent were deleted.",
    `Previous records: ${previous.length}. Records written: ${next.length}.`,
    emailType
      ? `EmailType sent: ${emailType}.`
      : "No EmailType was sent. Namecheap may keep or reset mail routing; re-read hosts to confirm.",
    "",
    "Records written:",
  ];
  for (const host of next) {
    const ttl = host.ttl != null ? `, TTL ${host.ttl}` : "";
    const mx = host.mxPref != null ? `, MXPref ${host.mxPref}` : "";
    lines.push(`- ${host.name} ${host.type} ${host.address}${ttl}${mx}`);
  }
  lines.push(jsonBlock({ domain, action, previousCount: previous.length, written: next, emailType: emailType || null }));
  return lines.join("\n");
}

export function assertNamecheapDns(zone, domain) {
  if (zone.isUsingOurDns === "false") {
    throw new NamecheapError(
      `Refusing to change DNS for ${domain}: Namecheap reports IsUsingOurDNS=false. Point the domain at Namecheap DNS first. No setHosts call was sent.`,
    );
  }
}
