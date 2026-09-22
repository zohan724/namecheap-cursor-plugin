import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  RECORD_TYPES,
  NamecheapError,
  applyHostEdit,
  assertNamecheapDns,
  attr,
  coerceHostForWrite,
  extractHosts,
  formatAuthStatus,
  formatBalances,
  formatCheck,
  formatDnsWrite,
  formatDomainInfo,
  formatDomainList,
  formatHosts,
  hostsToParams,
  inspectConfig,
  namecheapCall,
  normalizeDomainList,
  normalizeHost,
  redact,
  splitRegisteredDomain,
} from "./namecheap.mjs";

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const WRITE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

const hostShape = {
  name: z.string().describe("Host label. Use @ for the apex or * for a wildcard."),
  type: z.enum(RECORD_TYPES).describe("Namecheap record type."),
  address: z.string().describe("Record value: IP, hostname, URL, or text."),
  ttl: z.number().int().min(60).max(60000).optional().describe("TTL in seconds, from 60 to 60000."),
  mxPref: z.number().int().min(0).max(65535).optional().describe("Mail exchanger preference. Required for MX and MXE."),
};

function toolError(env, error) {
  const key = typeof env.NAMECHEAP_API_KEY === "string" ? env.NAMECHEAP_API_KEY.trim() : "";
  const message = error?.name === "TimeoutError" || error?.name === "AbortError"
    ? "Namecheap API request timed out after 30 seconds."
    : error instanceof Error && error.message
      ? error.message
      : "Namecheap request failed.";
  return {
    isError: true,
    content: [{ type: "text", text: redact(message, [key]) }],
  };
}

function toolText(env, text, warnings = []) {
  const key = typeof env.NAMECHEAP_API_KEY === "string" ? env.NAMECHEAP_API_KEY.trim() : "";
  const extra = warnings.length
    ? `\n\nNamecheap warnings:\n${warnings.map((item) => `- ${item.number ? `[${item.number}] ` : ""}${item.message}`).join("\n")}`
    : "";
  return { content: [{ type: "text", text: redact(`${text}${extra}`, [key]) }] };
}

function assertSetSuccess(parsed) {
  const success = attr(parsed.commandResponse?.DomainDNSSetHostsResult, "IsSuccess").toLowerCase() === "true";
  if (!success) {
    throw new NamecheapError(
      "Namecheap setHosts did not return IsSuccess=true. Read the host records again before retrying. Do not assume the previous records are intact.",
    );
  }
}

async function loadZone(domain, options) {
  const split = splitRegisteredDomain(domain);
  const parsed = await namecheapCall(
    "namecheap.domains.dns.getHosts",
    { SLD: split.sld, TLD: split.tld },
    options,
  );
  return { split, parsed, zone: extractHosts(parsed.commandResponse) };
}

export function createServer({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const options = { env, fetchImpl };
  const server = new McpServer(
    { name: "namecheap", version: "1.0.0" },
    {
      instructions:
        "Namecheap domain tools. Credentials come from plugin variables, never from chat. ClientIp is the whitelisted public IPv4 and is not auto-detected. DNS writes call setHosts and replace every host record. This server cannot register, renew, or transfer domains.",
    },
  );

  // Tools are registered at startup, whether or not credentials are configured.
  server.registerTool(
    "namecheap_auth_status",
    {
      title: "Namecheap auth status",
      description:
        "Report whether Namecheap plugin variables are set, show the configured ClientIp, and try a balance request when the configuration is complete. Does not reveal the API key and does not auto-detect an IP.",
      annotations: READ,
    },
    async () => {
      const config = inspectConfig(env);
      let balancesText;
      let pingError;
      if (config.ready) {
        try {
          const parsed = await namecheapCall("namecheap.users.getBalances", {}, options);
          balancesText = formatBalances(parsed.commandResponse);
        } catch (error) {
          pingError = error instanceof Error ? error.message : "Balance request failed.";
        }
      }
      return toolText(env, formatAuthStatus({ config, pingError, balancesText }));
    },
  );

  server.registerTool(
    "namecheap_list_domains",
    {
      title: "List Namecheap domains",
      description: "List domains in the Namecheap account (namecheap.domains.getList).",
      inputSchema: {
        page: z.number().int().min(1).optional().describe("Page number, starting at 1. Defaults to 1."),
        pageSize: z.union([z.literal(10), z.literal(20), z.literal(30), z.literal(50), z.literal(100)]).optional()
          .describe("Page size. Namecheap allows 10, 20, 30, 50, or 100. Defaults to 20."),
        listType: z.enum(["ALL", "EXPIRING", "EXPIRED"]).optional().describe("Which domains to include. Defaults to ALL."),
        sortBy: z.enum(["NAME", "NAME_DESC", "EXPIREDATE", "EXPIREDATE_DESC", "CREATEDATE", "CREATEDATE_DESC"]).optional()
          .describe("Sort order."),
        searchTerm: z.string().max(70).optional().describe("Optional search term."),
      },
      annotations: READ,
    },
    async ({ page = 1, pageSize = 20, listType, sortBy, searchTerm }) => {
      try {
        const parsed = await namecheapCall("namecheap.domains.getList", {
          Page: page,
          PageSize: pageSize,
          ListType: listType,
          SortBy: sortBy,
          SearchTerm: searchTerm?.trim(),
        }, options);
        return toolText(env, formatDomainList(parsed.commandResponse, { page, pageSize }), parsed.warnings);
      } catch (error) {
        return toolError(env, error);
      }
    },
  );

  server.registerTool(
    "namecheap_check_domains",
    {
      title: "Check domain availability",
      description:
        "Check whether one or more domains are available (namecheap.domains.check). This does not register a domain. Premium names include a price and still require a separate paid action.",
      inputSchema: {
        domains: z.string().min(1).describe("Comma-separated domain names, for example example.com,foo.io. Maximum 50."),
      },
      annotations: READ,
    },
    async ({ domains }) => {
      try {
        const list = normalizeDomainList(domains);
        const parsed = await namecheapCall("namecheap.domains.check", { DomainList: list.join(",") }, options);
        return toolText(env, formatCheck(parsed.commandResponse), parsed.warnings);
      } catch (error) {
        return toolError(env, error);
      }
    },
  );

  server.registerTool(
    "namecheap_get_domain_info",
    {
      title: "Get domain info",
      description: "Get details for one domain in the Namecheap account (namecheap.domains.getInfo).",
      inputSchema: {
        domain: z.string().min(1).describe("Domain name, for example example.com."),
      },
      annotations: READ,
    },
    async ({ domain }) => {
      try {
        const parsed = await namecheapCall("namecheap.domains.getInfo", { DomainName: domain.trim() }, options);
        return toolText(env, formatDomainInfo(parsed.commandResponse), parsed.warnings);
      } catch (error) {
        return toolError(env, error);
      }
    },
  );

  server.registerTool(
    "namecheap_get_dns_hosts",
    {
      title: "Get DNS hosts",
      description:
        "Get DNS host records for a domain on Namecheap DNS (namecheap.domains.dns.getHosts). Pass the registered domain, such as example.com or example.co.uk, not a hostname like www.example.com.",
      inputSchema: {
        domain: z.string().min(1).describe("Registered domain, for example example.com."),
      },
      annotations: READ,
    },
    async ({ domain }) => {
      try {
        const { parsed } = await loadZone(domain, options);
        return toolText(env, formatHosts(parsed.commandResponse), parsed.warnings);
      } catch (error) {
        return toolError(env, error);
      }
    },
  );

  server.registerTool(
    "namecheap_get_balances",
    {
      title: "Get account balances",
      description: "Get Namecheap account balances (namecheap.users.getBalances).",
      annotations: READ,
    },
    async () => {
      try {
        const parsed = await namecheapCall("namecheap.users.getBalances", {}, options);
        return toolText(env, formatBalances(parsed.commandResponse), parsed.warnings);
      } catch (error) {
        return toolError(env, error);
      }
    },
  );

  server.registerTool(
    "namecheap_set_dns_hosts",
    {
      title: "Replace all DNS hosts",
      description:
        "Replace ALL DNS host records for a domain (namecheap.domains.dns.setHosts). Records you omit are deleted. Read namecheap_get_dns_hosts first and pass the complete list. confirmReplaceAll must be true. This does not register or renew a domain.",
      inputSchema: {
        domain: z.string().min(1).describe("Registered domain, for example example.com."),
        confirmReplaceAll: z.literal(true).describe("Must be true. Acknowledges that omitted records are deleted."),
        emailType: z.string().min(1).max(20).optional().describe("Optional EmailType override. Omit to preserve the current mail routing mode."),
        hosts: z.array(z.object(hostShape)).min(1).max(100).describe("Complete replacement host list."),
      },
      annotations: WRITE,
    },
    async ({ domain, emailType, hosts }) => {
      try {
        const { split, zone } = await loadZone(domain, options);
        assertNamecheapDns(zone, split.domain);
        const next = hosts.map((host) => normalizeHost(host));
        const preservedEmailType = emailType?.trim() || zone.emailType;
        const params = hostsToParams(next, {
          sld: split.sld,
          tld: split.tld,
          emailType: preservedEmailType,
        });
        const written = await namecheapCall("namecheap.domains.dns.setHosts", params, options);
        assertSetSuccess(written);
        return toolText(env, formatDnsWrite({
          domain: split.domain,
          action: "full replace",
          previous: zone.hosts,
          next,
          emailType: preservedEmailType,
        }), written.warnings);
      } catch (error) {
        return toolError(env, error);
      }
    },
  );

  server.registerTool(
    "namecheap_update_dns_host",
    {
      title: "Update one DNS host",
      description:
        "Change one DNS record by reading the current hosts and sending the full set back through setHosts. Omitted records from the original set are preserved by this tool, but Namecheap still replaces the whole zone. confirmReplaceAll must be true. Pass remove:true to delete one record. Refuses to delete the final record. Does not register or renew a domain.",
      inputSchema: {
        domain: z.string().min(1).describe("Registered domain, for example example.com."),
        confirmReplaceAll: z.literal(true).describe("Must be true. Acknowledges that setHosts replaces the whole zone."),
        name: z.string().min(1).describe("Host name to match, such as www or @."),
        type: z.enum(RECORD_TYPES).describe("Record type to match."),
        address: z.string().optional().describe("Current address. Use it when more than one record has the same name and type."),
        remove: z.boolean().optional().describe("Delete the matched record."),
        record: z.object(hostShape).optional().describe("Replacement or new record. Required unless remove is true."),
      },
      annotations: WRITE,
    },
    async ({ domain, name, type, address, remove, record }) => {
      try {
        const { split, zone } = await loadZone(domain, options);
        assertNamecheapDns(zone, split.domain);
        const current = zone.hosts.map((host) => coerceHostForWrite(host));
        const edited = applyHostEdit(current, { name, type, address, remove: Boolean(remove), record });
        const params = hostsToParams(edited.next, {
          sld: split.sld,
          tld: split.tld,
          emailType: zone.emailType,
        });
        const written = await namecheapCall("namecheap.domains.dns.setHosts", params, options);
        assertSetSuccess(written);
        return toolText(env, formatDnsWrite({
          domain: split.domain,
          action: edited.action,
          previous: current,
          next: edited.next,
          emailType: zone.emailType,
        }), written.warnings);
      } catch (error) {
        return toolError(env, error);
      }
    },
  );

  return server;
}

export async function startServer() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}
