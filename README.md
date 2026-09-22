# Namecheap Cursor plugin

Cursor plugin that lets an agent list Namecheap domains, check availability, read DNS host records, and read account balance. DNS edits go through Namecheap `setHosts`, which replaces the whole host list. Registration, renewal, and transfer are not included.

The MCP server is bundled in this repository. It registers every tool at startup, including when credentials are missing.

## Install

After this repository is listed, install **Namecheap** from the [Cursor Marketplace](https://cursor.com/marketplace). Submit the public repo at [cursor.com/marketplace/publish](https://cursor.com/marketplace/publish).

To try it before it is listed:

1. Clone this repository.
2. Install server dependencies:

   ```bash
   npm ci --prefix mcp-server
   ```

   If `mcp-server/node_modules` is missing, `node mcp-server/index.mjs` runs `npm ci` once and writes npm output to stderr so the MCP stream stays intact.
3. In Cursor, copy the plugin folder to `~/.cursor/plugins/local/namecheap` (or load the folder your Cursor build uses for local plugins).
4. Reload the window and confirm the Namecheap rules, skill, and MCP server appear under Customize.

## Configure variables

Open **Plugins → Configure** on the Namecheap plugin and set:

| Variable | Required | Purpose |
| --- | --- | --- |
| `NAMECHEAP_API_USER` | Yes | Namecheap account username |
| `NAMECHEAP_API_KEY` | Yes | API key from Namecheap API Access |
| `NAMECHEAP_CLIENT_IP` | Yes | Public IPv4 whitelisted for that API key |
| `NAMECHEAP_USERNAME` | No | `UserName` on API calls. Defaults to the API user |

Do not paste the API key into chat. The repo and `mcp.json` contain `${NAMECHEAP_*}` placeholders only.

`NAMECHEAP_CLIENT_IP` is sent on every call. The server does not look up a public IP. Namecheap compares it with the caller address and accepts IPv4 only.

For a direct local process, export the same variables and run `npm start` inside `mcp-server`. Developers can point `NAMECHEAP_API_BASE` at `https://api.sandbox.namecheap.com/xml.response`. Any other host is rejected.

## Enable Namecheap API access

Production API access has to be turned on in Namecheap, and the caller IP has to be whitelisted. Namecheap's current production requirements are at least 20 domains in the account, at least $50 account balance, or at least $50 spent in the last two years. The sandbox has no spending requirement. Details: [API FAQ](https://www.namecheap.com/support/knowledgebase/article.aspx/9739/63/api-faq/) and [Intro to the API](https://www.namecheap.com/support/api/intro/).

1. Sign in to Namecheap (or the [sandbox](https://www.sandbox.namecheap.com/) for a dry run).
2. Open **Profile → Tools**.
3. Under **Business & Dev Tools**, choose **Manage** next to **Namecheap API Access**.
4. Turn access on, accept the terms, and confirm your password. Namecheap shows the API key once it is enabled.
5. Edit **Whitelisted IPs**, add the public IPv4 of the machine that will call the API, and save.
6. Put that same IPv4 in `NAMECHEAP_CLIENT_IP`.

If the agent runs on your computer, whitelist that network's public IPv4. If it runs in a cloud environment, whitelist that environment's egress IPv4. A home LAN address such as `192.168.x.x` will not match.

API reference: [global parameters](https://www.namecheap.com/support/api/global-parameters/) and the [method list](https://www.namecheap.com/support/api/methods/).

## Example prompts

- Check Namecheap auth status and show the configured client IP.
- List my Namecheap domains.
- Is example.com available to register?
- Show DNS host records for example.com.
- What is my Namecheap account balance?
- Add an A record for www.example.com and keep the other records.

Availability checks do not purchase a domain. DNS writes need an explicit confirmation because `setHosts` deletes any host record that is not sent again. Read [domains.dns.setHosts](https://www.namecheap.com/support/api/methods/domains-dns/set-hosts/) before changing a zone.

## Layout

```text
.cursor-plugin/plugin.json
mcp.json
mcp-server/
skills/namecheap-domains/SKILL.md
rules/namecheap-safety.mdc
assets/logo.svg
```

This is a single plugin at the repository root. There is no `.cursor-plugin/marketplace.json`.
