# SideShift outreach

Playwright invite script and the shared creator do-not-contact list for Visibletrader.

## Setup

Install Node.js, then run:

```sh
npm ci
npx playwright install chromium
node sideshift-bulk-invite.mjs
```

In the browser, log into SideShift, open Discover > Creators, apply your filters, and select the Visibletrader Creator Campaign job. Review `TARGET_INVITES`, `CHECKPOINT`, and the template checks in the script before running. The saved template must be named **Invite with pay** and match the greeting and terms checked in the script.

From a second terminal in this directory:

```sh
touch go
```

The script sends real invitations and uses invite credits. To stop, run `touch stop` or press Ctrl+C. If a checkpoint is enabled, `touch continue` resumes after the checkpoint.

## Shared list

`SideShift Outreach.csv` contains 2,206 unique creator names as of October 16, 2026. It is a do-not-contact list, including previous outreach and failed or excluded entries; it is not a count of confirmed sends. The script merges it with local `invited.json` on startup to avoid duplicate outreach.

Runtime files (`invited.json`, `invites.csv`, browser login profile, and control flags) stay local and are excluded from Git. To share later outreach, merge new names into the master CSV and commit that file. Existing local outreach state is preserved when using this repository.
