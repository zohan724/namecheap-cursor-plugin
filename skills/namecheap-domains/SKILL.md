---
name: namecheap-domains
description: >
  Look up and manage Namecheap domains, DNS host records, availability, and
  account balance. Use when the user asks about Namecheap domains, DNS,
  nameservers, registration, renewal, availability, WhoisGuard, or account balance.
---

# Namecheap domains

## When to use

Use this skill when the user asks about domains or DNS on their Namecheap account, whether a domain is available, account balance, or how to enable the Namecheap API.

## Instructions

1. Prefer the Namecheap MCP tools. Do not guess account contents.
2. Never ask the user to paste an API key, API user, or client IP into chat. Tell them to set plugin variables under Plugins → Configure.
3. Warn that `NAMECHEAP_CLIENT_IP` must be the public IPv4 address whitelisted in Namecheap (Profile → Tools → API Access). Namecheap rejects other addresses, including IPv6. This plugin does not auto-detect that IP.
4. Read tools are the default:
   - `namecheap_auth_status` when calls fail or credentials are in doubt
   - `namecheap_list_domains` for the account portfolio
   - `namecheap_check_domains` for availability (comma-separated). Say when a result is premium-priced
   - `namecheap_get_domain_info` for one owned domain
   - `namecheap_get_dns_hosts` for host records
   - `namecheap_get_balances` for balances
5. DNS writes use Namecheap `namecheap.domains.dns.setHosts`, which is a full replace. Omitted records are deleted. There is no single-record API.
   - For one record, use `namecheap_update_dns_host`. It re-reads every record, edits one, and writes the complete set back.
   - For a full zone replace, use `namecheap_set_dns_hosts` only with the complete host list.
   - Tell the user this is a full replace, show the records that will be written, and wait for confirmation. `confirmReplaceAll` must be true.
   - These calls work only when the domain uses Namecheap DNS.
6. Confirm before any paid action (register, renew, transfer, restore, or premium purchase). Those tools are not in this plugin. Do not treat `namecheap_check_domains` as an order.
7. If Namecheap returns a ClientIP or whitelist error, the configured IPv4 is not the address Namecheap sees. Ask the user to update the whitelist and the plugin variable. Do not ask them to paste the API key.
