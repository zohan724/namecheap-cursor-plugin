import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../lib/server.mjs";
import {
  applyHostEdit,
  formatDomainList,
  hostsToParams,
  inspectConfig,
  normalizeDomainList,
  parseApiXml,
  redact,
  splitRegisteredDomain,
} from "../lib/namecheap.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const API_KEY = "unit-test-api-key-value";
const ENV = {
  NAMECHEAP_API_USER: "zohan",
  NAMECHEAP_API_KEY: API_KEY,
  NAMECHEAP_CLIENT_IP: "203.0.113.10",
};

const LIST_XML = `<?xml version="1.0" encoding="utf-8"?>
<ApiResponse Status="OK" xmlns="http://api.namecheap.com/xml.response">
  <Errors />
  <Warnings />
  <RequestedCommand>namecheap.domains.getList</RequestedCommand>
  <CommandResponse Type="namecheap.domains.getList">
    <DomainGetListResult>
      <Domain ID="1" Name="example.com" User="zohan" Created="01/01/2020" Expires="01/01/2027" IsExpired="false" IsLocked="false" AutoRenew="true" WhoisGuard="ENABLED" IsPremium="false" IsOurDNS="true" />
    </DomainGetListResult>
    <Paging>
      <TotalItems>1</TotalItems>
      <CurrentPage>1</CurrentPage>
      <PageSize>20</PageSize>
    </Paging>
  </CommandResponse>
</ApiResponse>`;

const CHECK_XML = `<?xml version="1.0" encoding="utf-8"?>
<ApiResponse Status="OK" xmlns="http://api.namecheap.com/xml.response">
  <Errors />
  <RequestedCommand>namecheap.domains.check</RequestedCommand>
  <CommandResponse Type="namecheap.domains.check">
    <DomainCheckResult Domain="example.com" Available="true" ErrorNo="0" Description="" IsPremiumName="true" PremiumRegistrationPrice="12.00" PremiumRenewalPrice="12.00" />
  </CommandResponse>
</ApiResponse>`;

const HOSTS_XML = `<?xml version="1.0" encoding="utf-8"?>
<ApiResponse Status="OK" xmlns="http://api.namecheap.com/xml.response">
  <Errors />
  <RequestedCommand>namecheap.domains.dns.getHosts</RequestedCommand>
  <CommandResponse Type="namecheap.domains.dns.getHosts">
    <DomainDNSGetHostsResult Domain="example.com" EmailType="MX" IsUsingOurDNS="true">
      <host HostId="12" Name="@" Type="A" Address="1.2.3.4" MXPref="10" TTL="1800" />
      <host HostId="14" Name="www" Type="A" Address="1.2.3.5" MXPref="10" TTL="1800" />
    </DomainDNSGetHostsResult>
  </CommandResponse>
</ApiResponse>`;

const SET_XML = `<?xml version="1.0" encoding="utf-8"?>
<ApiResponse Status="OK" xmlns="http://api.namecheap.com/xml.response">
  <Errors />
  <RequestedCommand>namecheap.domains.dns.setHosts</RequestedCommand>
  <CommandResponse Type="namecheap.domains.dns.setHosts">
    <DomainDNSSetHostsResult Domain="example.com" IsSuccess="true" />
  </CommandResponse>
</ApiResponse>`;

const BALANCE_XML = `<?xml version="1.0" encoding="utf-8"?>
<ApiResponse Status="OK" xmlns="http://api.namecheap.com/xml.response">
  <Errors />
  <RequestedCommand>namecheap.users.getBalances</RequestedCommand>
  <CommandResponse Type="namecheap.users.getBalances">
    <UserGetBalancesResult Currency="USD" AvailableBalance="42.00" AccountBalance="42.00" EarnedAmount="0" WithdrawableAmount="0" FundsRequiredForAutoRenew="0" />
  </CommandResponse>
</ApiResponse>`;

function errorXml(message) {
  return `<?xml version="1.0" encoding="utf-8"?>
<ApiResponse Status="ERROR" xmlns="http://api.namecheap.com/xml.response">
  <Errors>
    <Error Number="1011102">${message}</Error>
  </Errors>
  <RequestedCommand>namecheap.users.getBalances</RequestedCommand>
</ApiResponse>`;
}

function xmlResponse(body, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "application/xml" } });
}

async function connectServer(options) {
  const server = createServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "namecheap-test", version: "1.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

test("plugin manifest declares every mcp.json placeholder except the Cursor root", () => {
  const plugin = JSON.parse(readFileSync(join(repoRoot, ".cursor-plugin/plugin.json"), "utf8"));
  const mcp = JSON.parse(readFileSync(join(repoRoot, "mcp.json"), "utf8"));
  const declared = new Set(Object.keys(plugin.variables.properties));
  const placeholders = new Set();
  const walk = (value) => {
    if (typeof value === "string") {
      for (const match of value.matchAll(/\$\{([A-Z0-9_]+)\}/g)) placeholders.add(match[1]);
      return;
    }
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(mcp);
  assert.equal(plugin.name, "namecheap");
  assert.equal(plugin.displayName, "Namecheap");
  assert.deepEqual(plugin.variables.required, ["NAMECHEAP_API_USER", "NAMECHEAP_API_KEY", "NAMECHEAP_CLIENT_IP"]);
  for (const name of placeholders) {
    if (name === "CURSOR_PLUGIN_ROOT") continue;
    assert.ok(declared.has(name), `${name} is missing from plugin variables`);
  }
  for (const value of Object.values(mcp.mcpServers.namecheap.env)) {
    assert.match(value, /^\$\{[A-Z0-9_]+\}$/);
  }
  assert.equal(mcp.mcpServers.namecheap.args[0], "${CURSOR_PLUGIN_ROOT}/mcp-server/index.mjs");
});

test("domain splitting accepts registered names and rejects hostnames", () => {
  assert.deepEqual(splitRegisteredDomain("Example.COM"), { domain: "example.com", sld: "example", tld: "com" });
  assert.deepEqual(splitRegisteredDomain("example.co.uk."), { domain: "example.co.uk", sld: "example", tld: "co.uk" });
  assert.throws(() => splitRegisteredDomain("www.example.com"), /example\.com/);
  assert.throws(() => splitRegisteredDomain("blog.example.co.uk"), /example\.co\.uk/);
  assert.deepEqual(normalizeDomainList(" Example.COM, foo.io "), ["example.com", "foo.io"]);
});

test("parsers turn Namecheap XML into a readable domain list", () => {
  const parsed = parseApiXml(LIST_XML);
  assert.equal(parsed.status, "OK");
  const text = formatDomainList(parsed.commandResponse, { page: 1, pageSize: 20 });
  assert.match(text, /example\.com/);
  assert.match(text, /Total domains: 1/);
  const check = parseApiXml(CHECK_XML);
  assert.equal(check.commandResponse.DomainCheckResult[0]["@_Available"], "true");
});

test("API errors stay explicit and secrets are redacted", () => {
  const parsed = parseApiXml(errorXml(`bad key ${API_KEY}`));
  assert.equal(parsed.status, "ERROR");
  assert.equal(parsed.errors[0].number, "1011102");
  assert.equal(redact(parsed.errors[0].message, [API_KEY]).includes(API_KEY), false);
  assert.match(redact("https://api.namecheap.com/xml.response?ApiKey=secret-value", []), /ApiKey=\[redacted\]/);
});

test("single-record edit keeps the other hosts and refuses a wipe", () => {
  const existing = [
    { name: "@", type: "A", address: "1.2.3.4", ttl: 1800, mxPref: 10 },
    { name: "www", type: "A", address: "1.2.3.5", ttl: 1800, mxPref: 10 },
  ];
  const replaced = applyHostEdit(existing, {
    name: "www",
    type: "A",
    record: { name: "www", type: "A", address: "9.9.9.9", ttl: 300 },
  });
  assert.equal(replaced.action, "replace");
  assert.equal(replaced.next.length, 2);
  assert.equal(replaced.next[0].address, "1.2.3.4");
  assert.equal(replaced.next[1].address, "9.9.9.9");
  assert.throws(() => applyHostEdit([existing[0]], { name: "@", type: "A", remove: true }), /last DNS record/);
  const params = hostsToParams(replaced.next, { sld: "example", tld: "com", emailType: "MX" });
  assert.equal(params.HostName1, "@");
  assert.equal(params.Address2, "9.9.9.9");
  assert.equal(params.EmailType, "MX");
});

test("tools are registered before any credential check", async () => {
  const session = await connectServer({ env: {} });
  try {
    const listed = await session.client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "namecheap_auth_status",
      "namecheap_check_domains",
      "namecheap_get_balances",
      "namecheap_get_dns_hosts",
      "namecheap_get_domain_info",
      "namecheap_list_domains",
      "namecheap_set_dns_hosts",
      "namecheap_update_dns_host",
    ]);
    const auth = await session.client.callTool({ name: "namecheap_auth_status", arguments: {} });
    const text = auth.content[0].text;
    assert.match(text, /NAMECHEAP_API_USER/);
    assert.match(text, /NAMECHEAP_CLIENT_IP/);
    assert.equal(text.includes("undefined"), false);
  } finally {
    await session.close();
  }
});

test("calls use the configured ClientIp and hide the API key", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const params = new URLSearchParams(init.body);
    calls.push({ url, params: Object.fromEntries(params) });
    const command = params.get("Command");
    if (command === "namecheap.users.getBalances") return xmlResponse(BALANCE_XML);
    if (command === "namecheap.domains.getList") return xmlResponse(LIST_XML);
    if (command === "namecheap.domains.check") return xmlResponse(CHECK_XML);
    if (command === "namecheap.domains.dns.getHosts") return xmlResponse(HOSTS_XML);
    if (command === "namecheap.domains.dns.setHosts") return xmlResponse(SET_XML);
    return xmlResponse(errorXml("unexpected"));
  };
  const session = await connectServer({ env: ENV, fetchImpl });
  try {
    const balances = await session.client.callTool({ name: "namecheap_get_balances", arguments: {} });
    assert.match(balances.content[0].text, /42\.00 USD/);
    assert.equal(balances.content[0].text.includes(API_KEY), false);
    assert.equal(calls[0].url, "https://api.namecheap.com/xml.response");
    assert.equal(calls[0].params.ClientIp, "203.0.113.10");
    assert.equal(calls[0].params.ApiUser, "zohan");
    assert.equal(calls[0].params.UserName, "zohan");
    assert.equal(calls[0].params.ApiKey, API_KEY);

    const listed = await session.client.callTool({ name: "namecheap_list_domains", arguments: { page: 1, pageSize: 20 } });
    assert.equal(listed.isError, undefined);
    assert.match(listed.content[0].text, /example\.com/);

    const checked = await session.client.callTool({
      name: "namecheap_check_domains",
      arguments: { domains: "example.com" },
    });
    assert.match(checked.content[0].text, /premium registration price 12\.00/);
    assert.match(checked.content[0].text, /does not register/);

    const updated = await session.client.callTool({
      name: "namecheap_update_dns_host",
      arguments: {
        domain: "example.com",
        confirmReplaceAll: true,
        name: "www",
        type: "A",
        record: { name: "www", type: "A", address: "9.9.9.9", ttl: 300 },
      },
    });
    assert.equal(updated.isError, undefined);
    assert.match(updated.content[0].text, /replaced the entire host list/i);
    assert.equal(updated.content[0].text.includes(API_KEY), false);
    const setCall = calls.find((call) => call.params.Command === "namecheap.domains.dns.setHosts");
    assert.equal(setCall.params.SLD, "example");
    assert.equal(setCall.params.TLD, "com");
    assert.equal(setCall.params.EmailType, "MX");
    assert.equal(setCall.params.HostName1, "@");
    assert.equal(setCall.params.Address1, "1.2.3.4");
    assert.equal(setCall.params.HostName2, "www");
    assert.equal(setCall.params.Address2, "9.9.9.9");
    assert.equal(setCall.params.TTL2, "300");
  } finally {
    await session.close();
  }
});

test("a failed balance ping is reported without throwing away the status", async () => {
  const fetchImpl = async () => xmlResponse(errorXml(`rejected ${API_KEY}`));
  const session = await connectServer({ env: ENV, fetchImpl });
  try {
    const auth = await session.client.callTool({ name: "namecheap_auth_status", arguments: {} });
    assert.match(auth.content[0].text, /203\.0\.113\.10/);
    assert.match(auth.content[0].text, /1011102/);
    assert.equal(auth.content[0].text.includes(API_KEY), false);
    assert.match(auth.content[0].text, /\[redacted\]/);
  } finally {
    await session.close();
  }
});

test("DNS writes are refused when the domain is not on Namecheap DNS", async () => {
  const foreign = HOSTS_XML.replace('IsUsingOurDNS="true"', 'IsUsingOurDNS="false"');
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const params = new URLSearchParams(init.body);
    calls.push(params.get("Command"));
    return xmlResponse(foreign);
  };
  const session = await connectServer({ env: ENV, fetchImpl });
  try {
    const result = await session.client.callTool({
      name: "namecheap_set_dns_hosts",
      arguments: {
        domain: "example.com",
        confirmReplaceAll: true,
        hosts: [{ name: "@", type: "A", address: "1.2.3.4" }],
      },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /No setHosts call was sent/);
    assert.deepEqual(calls, ["namecheap.domains.dns.getHosts"]);
  } finally {
    await session.close();
  }
});

test("missing credentials fail the read tools with setup guidance", async () => {
  let fetched = false;
  const session = await connectServer({
    env: {},
    fetchImpl: async () => {
      fetched = true;
      return xmlResponse(BALANCE_XML);
    },
  });
  try {
    const result = await session.client.callTool({ name: "namecheap_get_balances", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Plugins → Configure/);
    assert.equal(fetched, false);
    const config = inspectConfig({ NAMECHEAP_API_USER: "zohan", NAMECHEAP_API_KEY: API_KEY, NAMECHEAP_CLIENT_IP: "10.0.0.8" });
    assert.equal(config.ready, true);
    assert.match(config.ipWarning, /private/i);
  } finally {
    await session.close();
  }
});
