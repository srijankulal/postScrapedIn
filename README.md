# PostScrapedIn - LinkedIn Post Exporter

A clean, production-ready, offline-first Chrome Extension (Manifest V3) that extracts your published LinkedIn posts and outputs them as clean, concatenated text or JSON.

---

## 🛡️ Built-in Safeguards & Guardrails

To protect your LinkedIn account integrity and guarantee personal data privacy, PostScrapedIn includes several built-in guardrails:

### 1. 🔒 100% Client-Side & Zero-Telemetry (Absolute Privacy)
- **No External Servers**: Zero webhooks, zero proxies, zero third-party analytical APIs, and zero remote databases.
- **Local Authentication**: Your session cookies (`li_at` and `JSESSIONID`) are parsed in-memory strictly inside your browser and **never leave your local machine**.
- **No Hardcoded Credentials**: Operates strictly on your active browser session without storing passwords.

### 2. ⏱️ Anti-429 Rate Limiting & Account Protection
- **Enforced Throttling**: Automatically injects a 500ms–850ms delay between paginated batch requests and scroll operations to prevent triggering LinkedIn's rate limiter (`HTTP 429 Too Many Requests`).
- **Configurable Limits**: You choose the exact volume of posts to retrieve (25, 50, 100, 250, 500, or All) to prevent runaway loops.
- **Smart Termination**: Automatically halts execution when feed ends, when max scrolls are reached, or when no new posts are detected for consecutive cycles.

### 3. 🎯 Authored Post Purity (Noise & Comment Filtering)
- **Dedicated Target (`/recent-activity/posts/`)**: Routes directly to your published posts feed.
- **Activity Filter**: Automatically detects and skips external comments ("commented on..."), likes, and third-party feed reactions to ensure **100% authored post purity**.
- **Full Text Expansion**: Automatically expands `...see more` triggers before extracting content to eliminate truncated strings (`...`).
- **Deduplication Engine**: Uses `Set`-based tracking on activity URNs and content hashes to prevent duplicated entries.

### 4. 🧹 Clean Resource Lifecycle
- **Automatic Tab Cleanup**: Any temporary background tab created during DOM extraction is immediately closed upon completion.
- **Safe Session Handling**: If session tokens expire or you log out, the extension displays a clear error banner and halts further network requests.

### 5. 🛡️ Manifest V3 & Least Privilege Compliance
- **No Remote Code Execution**: Uses strictly local static JavaScript conforming to Chrome Web Store security standards.
- **Scoped Host Permissions**: Network and scripting permissions are restricted strictly to `https://www.linkedin.com/*`.

---

## 📂 Project Structure

```
postScrapedIn/
├── manifest.json       # Manifest V3 configuration, permissions, and security scope
├── background.js       # Background Service Worker for cookie/CSRF retrieval
├── popup.html          # Clean dark-mode UI with controls, progress bar & outputs
├── popup.js            # Dual-engine fetcher, rate limiting, DOM parser & exporters
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md           # Documentation & guardrail specifications
```

---

## 🚀 Step-by-Step Installation

1. **Open Extensions Page**:
   - Open Google Chrome (or any Chromium browser like Brave, Edge, Arc).
   - In the address bar, go to: `chrome://extensions`.
2. **Enable Developer Mode**:
   - Toggle the **Developer mode** switch in the top-right corner to **ON**.
3. **Load Unpacked Extension**:
   - Click the **Load unpacked** button in the top-left corner.
   - Select the folder:
     ```
     c:\Codes\Projects\postScrapedIn
     ```
4. **Pin to Toolbar**:
   - Click the puzzle icon (Extensions) in your browser toolbar and pin **PostScrapedIn**.

---

## 📖 How to Use

1. Ensure you are logged in to [linkedin.com](https://www.linkedin.com).
2. Click the **PostScrapedIn** extension icon in your toolbar.
3. Verify your verified name/headline is displayed on the profile card.
4. Set the **Scope** to:
   - **`My Posts Only` (Recommended)**: Extracts strictly posts published by you.
   - **`Shares & Articles`**: Includes long-form articles and shares.
   - **`All Activity`**: Includes posts, reposts, and reactions.
5. Select your desired **Max Count** (e.g. 50, 100, 250).
6. Click **Fetch Posts**.
7. Once finished, use:
   - 📋 **Copy**: Copies cleanly formatted text with dividers and timestamps to clipboard.
   - 📄 **.txt**: Downloads a timestamped `.txt` backup file.
   - 📦 **.json**: Downloads full structured JSON containing metadata, URNs, and post bodies.

---

## 📄 Output Formats

### Plain Text (`.txt`) Output:
```text
============================================================
POST #1 | Published: Oct 1, 2026, 14:30 UTC
URL: https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678
URN: urn:li:activity:7123456789012345678
------------------------------------------------------------
Excited to announce our new project release! Here is a deep dive...
============================================================
```

### JSON (`.json`) Output:
```json
{
  "exportedAt": "2026-10-01T22:10:00.000Z",
  "exporter": "PostScrapedIn v1.0",
  "profile": {
    "fullName": "Your Name",
    "headline": "Software Developer"
  },
  "totalPosts": 42,
  "posts": [
    {
      "index": 1,
      "urn": "urn:li:activity:7123456789012345678",
      "url": "https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678",
      "publishedAt": "2d",
      "mediaType": "text",
      "articleTitle": "",
      "articleUrl": "",
      "text": "Excited to announce our new project release! Here is a deep dive..."
    }
  ]
}
```
