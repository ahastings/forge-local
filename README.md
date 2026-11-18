# Local API Dev Lab

An experimental Windows coding-agent starter for exploring the OpenAI API with your own API account and eligible credits. It has a local web interface. It uses the OpenAI **Responses API** directly, with tools for reading and editing project files and requesting PowerShell commands. It does not invoke Codex CLI or use your ChatGPT login.

## Project status

Early development preview. Thirty-nine automated checks pass, including simulated agent and dictation flows and real Windows file, command, encryption, and HTTP checks. Automated API integration tests use simulated responses; model access and billing depend on your account. A separate browser integration check recorded generated speech, transcribed it through the live OpenAI API, appended the text to a draft and verified control cleanup. The app tests API access; it cannot verify your free-credit balance or enforce free-credit-only spending.

## Start

1. Double-click **Start API Dev Lab.cmd** in this folder. Keep its console window open while using the app.
2. Your browser opens **http://127.0.0.1:4317**. The server listens only on your computer's loopback interface.
3. Open **Settings**, enter an OpenAI project API key, and save. Use a key from the API organization linked to your free-credit benefit.
4. Choose a project folder, or try the included **hello-windows** starter.
5. Describe your task. Use the **PowerShell** dropdown above the chat to choose **Ask each time** or **Automatic**. The choice is saved separately for each project folder.

Node.js 22 or newer and Windows PowerShell 5.1 are required. Node.js 24 was already installed on the computer used to build and test this app. There are no npm dependencies and no npm install step.

To stop the app, press Ctrl+C in its console or close that console. **Stop** inside the app cancels the current task and its running command; it leaves the server available for another task. Nothing is registered to start with Windows.

From a terminal you can also run `npm start`. Set `PORT` in an ignored `.env` file to change the default port. If the port is already in use, stop the other process or choose another port.

## First task

Open the included starter project and try:

> Build a responsive task tracker with plain HTML, CSS, and JavaScript. Save tasks in browser localStorage. Add instructions for launching it on Windows. Verify the JavaScript syntax.

The agent inspects files, makes edits, requests commands, and uses command results to continue working. You can inspect files in the editor, make your own edits, start a fresh chat, and return to previous project chats.

## Open projects from chat

Paste an existing Windows folder path directly into chat, or type `open C:\path\to\project`. Standalone folder commands are handled locally without an API call. You can also paste a path into the PROJECT bar above the chat and click Open folder.

For a request such as "Open C:\path\to\project and inspect its instructions", the agent has an `open_project` tool. It can select only folders explicitly named in your user messages, including an earlier request followed by "okay". The tool returns the verified folder and top-level file listing. Previous file-tool output is removed from the model context when switching projects. File contents and instructions still need to be read through tools before making claims about them.

The active folder is visible above every chat. Approval preferences remain specific to each project.

Agent tool results are saved with the project path, completion time, exit status, and a bounded output excerpt. Expand View result in the chat to inspect them. The last six results for the current project are provided to follow-up API calls as historical evidence, with bounded excerpts. Old command results that were never recorded cannot be reconstructed.

## Speak into the chat

Click the microphone beside Send, allow microphone access, and wait for **Listening**. Words appear directly in the normal message box as you speak. A compact waveform beside the model and mic scrolls from right to left in response to input sound. Recording adds no panel or extra composer height. Recognition can lag slightly behind speech and may revise earlier words.

Click the microphone again to finish. The final transcript replaces the same spoken range without duplicating words, and the message becomes editable. Review or edit it, then send it yourself. Speech is inserted at the caret, replacing selected text if any; the rest of the draft is preserved. The message box is temporarily read-only while dictation is active so recognition revisions cannot overwrite manual edits. Cancel (×) or Escape restores the exact draft from before recording. Dictation never automatically submits a task or runs a command.

Recording uses the browser/Windows default input microphone. Change it in Windows Settings → System → Sound or the browser's microphone settings. Current Chrome and Edge support the required microphone and WebRTC features at the local app URL. If an embedded browser blocks access, open **http://127.0.0.1:4317** in Chrome or Edge. Allow microphone permission yourself.

Live dictation streams audio to OpenAI while the mic is connected. The server uses your saved API key to negotiate a short-lived transcription session; neither the saved key nor the temporary credential is returned to the browser. Audio travels over WebRTC and transcript events return over its data channel. No spoken assistant response is requested. Live transcription uses `gpt-live-transcribe`, following [OpenAI's realtime transcription guide](https://developers.openai.com/api/docs/guides/realtime-transcription), checked November 18, 2026.

If the live connection is unavailable, a visible notice explains that text will appear after stopping. A recording held in memory can then be transcribed through the existing `gpt-transcribe` file endpoint. Healthy live sessions do not also upload that backup. Finalization failures can require the fallback, so partial live work and a file request may both incur usage. No microphone audio is saved to the app's data directory.

Recording stops automatically at two minutes and the backup must fit within 5 MB. Cancel or Escape removes the spoken text and restores the original draft; changing chats/folders or leaving the page closes the live connection. The × button also cancels pending finalization. Live startup is bounded at 15 seconds, finalization at 10 seconds, and the overall final transcript wait at 45 seconds. Cancelling cannot undo API usage already received by OpenAI.

Transcription consumes your API account balance, subject to model permissions and credit eligibility. The coding-agent call/token meter does not include audio charges. The full browser flow was checked with generated speech, including words in the message box before stopping, an animated waveform, final text without duplication, and cleanup. Your own physical microphone still needs its capture test. Automated tests use simulated audio and provider responses.

## Connect your credits

The credit grant must be activated and linked to the API organization used by your key. Open **API Platform → Billing** to confirm that organization and its balance:

- [OpenAI API billing](https://platform.openai.com/settings/organization/billing/overview)
- [API credit benefit and covered services](https://developers.openai.com/api/docs/guides/chatgpt-api-credits)
- [API keys](https://platform.openai.com/api-keys)
- [API usage](https://platform.openai.com/usage)

OpenAI's documentation includes Responses API usage for code and agent development in the benefit and excludes Codex usage through API keys. This app makes ordinary Responses API calls. Your API account determines model availability, credit eligibility, rate limits, and billing.

**The app cannot query or enforce a free-credit-only balance.** Eligible credits are applied by OpenAI; purchased funds or other configured billing may be used after the grant is exhausted. Check billing, spending controls, and recharge settings in your API account. A successful key test only confirms access to the model-list endpoint. It does not prove remaining credits or access to the Responses endpoint or a particular model.

Default: `gpt-6.1-sol`, low reasoning, at most 12 API rounds per task and 8,192 output tokens per call. Change these in Settings. The limits bound individual requests and loops; they are not a dollar budget. The usage meter shows tokens reported by the API, including reasoning tokens in output usage. Follow-up tasks consume additional API usage. The default model was checked against OpenAI's documentation on November 16, 2026.

## Saved goal mode

Click Goals to save an objective, completion criteria, instructions, allowed project folders and optional read-only reference folders. Saving creates a draft and makes no model request. Run goal starts bounded work cycles; Pause/Stop preserves completed changes and the latest checkpoint. Resume uses a fresh per-run call allowance and the saved goal state. The default is three cycles and 24 API calls per user-started run, further bounded by each cycle's Settings limits. These limits are not a dollar budget or a free-credit-only guarantee.

Completion criteria require actual successful tool-call IDs. A model's final message alone cannot complete the saved goal. Saved evidence and criteria still need human review; the app cannot independently prove every semantic claim. Missing external data or access can leave a goal blocked. Application restart pauses a running goal and never automatically resumes model spending. No scheduler or Windows startup job is created.

Goals can use up to six explicitly allowed project folders. For an active goal, file mutations and shell calls made from a read-only reference folder are blocked. This is an application-level control, not an operating-system sandbox; an approved shell still runs as your Windows user. Preserve project instructions and keep goal scopes specific.

Personal presets, goal state, chat history and checkpoints live under ignored .local-data. They are excluded from source control and portable uploads. Working project folders are also private; only clean starter instructions are included.
## Files, commands, and privacy

- **File tools:** limited to the selected folder. Parent traversal, alternate data streams, links/junctions, common credential files, `.env` files, and internal directories are excluded. Existing files must be read before overwriting; a hash detects intervening changes. Text files up to 300 KB are supported. Dependency/build directories are omitted from listings.
- **Changes:** file-tool and editor writes save before/after snapshots in the app's `.local-data/changes.json`. View a diff or undo in reverse order. Undo refuses to overwrite newer external changes. These snapshots are not a replacement for Git or an independent backup.
- **PowerShell:** new project folders default to **Ask each time**. Choose **Automatic** in the PowerShell dropdown, or **Allow automatically for this project** on a pending command, to approve commands for that project without repeated prompts. The choice persists across tasks and restarts, and can be switched back at any time. Commands run as your Windows user, with a 120-second timeout. **A working folder is not a sandbox**: an approved command can access other files or the network with your user's permissions. Source file edits are best done through the backed-up file tools. Changes made by shell commands are not captured by Changes. Enable automatic mode only for project work you trust.
- **Stop:** cancels the API request and terminates the app-owned PowerShell process tree. Completed file edits remain saved. Do not start unattended/background servers through the agent; it provides launch commands for you to run separately.
- **Key:** encrypted using Windows DPAPI for your Windows account and saved in `.local-data/key.dpapi`. The server never sends the saved key back to the browser or passes it in the environment of project commands. You may instead set `OPENAI_API_KEY` in the process environment or this app's ignored `.env`. Do not commit these files or copy your data directory into a shared build.
- **Chats and snapshots:** stored locally as plaintext in `.local-data`. Files and command output used as model context are transmitted to OpenAI. Responses API requests use `store: false`; dictation audio uses Realtime transcription and the Audio API. OpenAI's applicable API data-retention policies still apply to both.
- **Local access:** loopback binding, Host/Origin validation, SameSite/HttpOnly cookies, a custom mutation header, a content-security policy, and escaped model output protect the web interface from ordinary cross-site requests. This is a single-user prototype, not a multi-user or remotely exposed service.

## Development and verification

Run `npm test` and `npm run check` from this folder. Windows checks include real PowerShell execution/cancellation, file write/undo and conflict handling, junction/traversal protection, DPAPI encryption, HTTP access controls, command approval/denial, and a simulated multi-step agent task. Dictation checks cover native browser timer and fetch binding, live transcript ordering and finalization, server-side credential exchange, live fallback, the default mic constraint, stopping/cancelling, missing stop events, late microphone permissions and transcripts, recording/transcription timeouts, preserved drafts, bounded audio uploads, multipart API requests and provider errors. Tests make no live OpenAI calls. Windows process control, DPAPI, and junction creation must be available to the test process.

The first release was tested without a real API key because none was available in the shared configuration or Windows environment. Its API streaming and agent loop were verified with simulated Responses events. After connecting your actual key, run a small task in the starter folder to confirm your account's model access and credits.

Architecture: `server.js` serves the local API and UI; `lib/agent.js` orchestrates Responses function calls; `lib/workspace.js` handles paths, conflicts, and snapshots; `lib/windows.js` handles Windows processes and encryption; `lib/transcription.js` validates recorded audio and calls OpenAI; `lib/live-transcription.js` negotiates live audio without exposing credentials. The frontend in `public/` uses plain JavaScript and CSS, with microphone lifecycle management in `voice-input.js`. This structure can later support a desktop wrapper, better diff editing, additional providers, and a Windows sandbox.
