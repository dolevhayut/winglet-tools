# Registry submissions

Artifacts prepared for listing. **Nothing here has been submitted** — each target
needs an account and a signed-in human. Submit them yourself; this directory is
the copy you paste.

Deliberately excluding npm for now: the installation channel is still an open
question, and every entry below points at the MCP server and the skill rather
than at `npx`, so none of them has to change if that decision changes.

| Target | What to submit | Where |
|---|---|---|
| MCP Registry (official) | `mcp-server.json` | https://github.com/modelcontextprotocol/registry — read its CONTRIBUTING first; it is a PR against the registry repo |
| Claude Code / agent skills | the `skills/winglet/` directory | publish as a git repo, then `npx skills add <owner>/<repo>` |
| Smithery | `mcp-server.json` + the Docker image | https://smithery.ai — connects a GitHub repo |
| Glama MCP directory | repo URL | https://glama.ai/mcp/servers |
| awesome-mcp-servers | one line in the README | https://github.com/punkpeye/awesome-mcp-servers |
| openalternative.co | product entry, "open-source alternative to" framing | https://openalternative.co — note: expects an open-source repo, which this is not |

## Before submitting anything

1. The MCP server must be reachable at a stable URL, or published as an image
   users can pull. Right now it runs from a locally built image.
2. `mcp-server.json` carries a placeholder repository URL — replace it.
3. Decide the licence line. The repo is proprietary, which several directories
   above will reject or downrank; that is a product decision, not an oversight.
