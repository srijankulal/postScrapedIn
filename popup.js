/**
 * popup.js - Multi-strategy LinkedIn Post Exporter (Voyager REST + GraphQL + Direct Activity Feed Tab Extraction)
 */

// State
let sessionState = {
  isLoggedIn: false,
  csrfToken: null,
  profile: null,
};

let extractedPosts = [];
let isFetching = false;

// DOM Elements
const statusDot = document.getElementById('statusDot');
const sessionStatusText = document.getElementById('sessionStatusText');
const authErrorBanner = document.getElementById('authErrorBanner');
const loginLink = document.getElementById('loginLink');
const profileName = document.getElementById('profileName');
const profileHeadline = document.getElementById('profileHeadline');
const postCountBadge = document.getElementById('postCountBadge');
const postLimitSelect = document.getElementById('postLimit');
const postTypeSelect = document.getElementById('postType');
const fetchBtn = document.getElementById('fetchBtn');
const fetchBtnSpinner = document.getElementById('fetchBtnSpinner');
const fetchBtnText = document.getElementById('fetchBtnText');
const progressSection = document.getElementById('progressSection');
const progressMessage = document.getElementById('progressMessage');
const progressPercent = document.getElementById('progressPercent');
const progressBar = document.getElementById('progressBar');
const outputArea = document.getElementById('outputArea');
const charCount = document.getElementById('charCount');
const copyBtn = document.getElementById('copyBtn');
const downloadTxtBtn = document.getElementById('downloadTxtBtn');
const downloadJsonBtn = document.getElementById('downloadJsonBtn');
const clearBtn = document.getElementById('clearBtn');

// Initialize on popup load
document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  await verifySessionAndLoadProfile();
});

function setupEventListeners() {
  fetchBtn.addEventListener('click', handleFetchPosts);
  copyBtn.addEventListener('click', handleCopyToClipboard);
  downloadTxtBtn.addEventListener('click', handleDownloadTxt);
  downloadJsonBtn.addEventListener('click', handleDownloadJson);
  clearBtn.addEventListener('click', handleClearOutput);

  if (loginLink) {
    loginLink.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: 'https://www.linkedin.com/login' });
    });
  }
}

/**
 * Verifies active LinkedIn cookie session via background service worker
 * and loads the current user profile from /voyager/api/me.
 */
async function verifySessionAndLoadProfile() {
  updateStatus('Checking session...', 'warning');

  chrome.runtime.sendMessage({ action: 'GET_LINKEDIN_SESSION' }, async (response) => {
    if (chrome.runtime.lastError || !response || !response.success) {
      const err = response?.error || chrome.runtime.lastError?.message || 'Session verification failed.';
      showAuthError(err);
      return;
    }

    sessionState.isLoggedIn = true;
    sessionState.csrfToken = response.data.csrfToken;

    try {
      updateStatus('Connected', 'online');
      hideAuthError();

      // Fetch Profile info from /voyager/api/me
      const profile = await fetchUserProfile(sessionState.csrfToken);
      sessionState.profile = profile;

      profileName.textContent = profile.fullName || 'LinkedIn User';
      profileHeadline.textContent = profile.headline || 'Active Session Verified';

      fetchBtn.disabled = false;
      progressMessage.textContent = 'Session ready. Choose limit and click Fetch.';
    } catch (err) {
      console.warn('Profile fetch warning:', err);
      profileName.textContent = 'Active LinkedIn User';
      profileHeadline.textContent = 'Session verified (Profile details omitted)';
      fetchBtn.disabled = false;
    }
  });
}

/**
 * Fetch profile identity from LinkedIn Voyager API
 */
async function fetchUserProfile(csrfToken) {
  const res = await fetch('https://www.linkedin.com/voyager/api/me', {
    method: 'GET',
    headers: {
      'csrf-token': csrfToken,
      'x-restli-protocol-version': '2.0.0',
      'accept': 'application/vnd.linkedin.normalized+json+2.1, application/json;q=0.9',
      'x-li-lang': 'en_US'
    },
    credentials: 'include'
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => '');
    throw new Error(`Profile API returned HTTP ${res.status}: ${errorBody}`);
  }

  const data = await res.json();
  
  let fullName = '';
  let headline = '';
  let profileUrn = '';
  let publicIdentifier = '';
  let plainId = data.plainId || '';

  if (data.miniProfile) {
    fullName = `${data.miniProfile.firstName || ''} ${data.miniProfile.lastName || ''}`.trim();
    headline = data.miniProfile.occupation || data.miniProfile.headline || '';
    publicIdentifier = data.miniProfile.publicIdentifier || '';
    profileUrn = data.miniProfile.dashEntityUrn || 
                 (data.miniProfile.entityUrn ? data.miniProfile.entityUrn.replace('urn:li:fs_miniProfile:', 'urn:li:fsd_profile:') : '') ||
                 (data.miniProfile.objectUrn || '');
  }

  if (!profileUrn && plainId) {
    profileUrn = `urn:li:member:${plainId}`;
  }

  return { fullName, headline, profileUrn, publicIdentifier, plainId, raw: data };
}

/**
 * Main function to fetch posts with Multi-Strategy Fallback:
 * 1. Voyager API & GraphQL (RestLi)
 * 2. Active Tab / Direct Web Activity Feed Extraction
 */
async function handleFetchPosts() {
  if (isFetching || !sessionState.csrfToken) return;

  isFetching = true;
  extractedPosts = [];
  setFetchingUIState(true);
  outputArea.value = '';
  updateCharCount();

  const maxPosts = parseInt(postLimitSelect?.value, 10) || 100;
  const scope = postTypeSelect?.value || 'posts'; // 'posts' (own posts), 'shares', 'all'

  try {
    progressMessage.textContent = 'Attempting direct API extraction...';
    const apiSuccess = await tryFetchViaVoyagerApi(maxPosts, scope);

    if (!apiSuccess || extractedPosts.length === 0) {
      progressMessage.textContent = 'Extracting your posts from LinkedIn Activity Feed...';
      await sleep(300);
      await fetchViaTabExtraction(maxPosts, scope);
    }

    if (extractedPosts.length > 0) {
      updateProgress(extractedPosts.length, maxPosts, true);
      progressMessage.textContent = `Completed! Extracted ${extractedPosts.length} posts.`;
    } else {
      progressMessage.textContent = 'No published posts found in this account.';
    }
  } catch (error) {
    console.error('Fetch error:', error);
    progressMessage.textContent = `Error: ${error.message}`;
    alert(`Error: ${error.message}`);
  } finally {
    isFetching = false;
    setFetchingUIState(false);
    renderFormattedTextOutput();
  }
}

/**
 * Strategy 1: Voyager REST & GraphQL API Fetcher
 */
async function tryFetchViaVoyagerApi(maxPosts, scope) {
  const pageSize = 20;
  let start = 0;
  let hasMore = true;
  let totalFetched = 0;
  let successfulConfig = null;

  const profile = sessionState.profile || {};
  const rawMe = profile.raw || {};
  const miniProfile = rawMe.miniProfile || {};

  const candidateUrns = new Set();
  if (profile.profileUrn) candidateUrns.add(profile.profileUrn);
  if (miniProfile.dashEntityUrn) candidateUrns.add(miniProfile.dashEntityUrn);
  if (miniProfile.entityUrn) {
    candidateUrns.add(miniProfile.entityUrn);
    candidateUrns.add(miniProfile.entityUrn.replace('urn:li:fs_miniProfile:', 'urn:li:fsd_profile:'));
  }
  if (profile.plainId || rawMe.plainId) {
    candidateUrns.add(`urn:li:member:${profile.plainId || rawMe.plainId}`);
    candidateUrns.add(`urn:li:fsd_profile:${profile.plainId || rawMe.plainId}`);
  }

  const urlTemplates = [];

  // GraphQL query candidate IDs for profile activity updates
  const graphQlQueryIds = [
    'voyagerIdentityDashProfileUpdates.7b6f27ff9d47d4e514f7cfef75ee9a07',
    'voyagerIdentityDashProfileUpdates.a0a256dfdcf7ef13f1d431c34a211993',
    'voyagerIdentityDashProfileUpdates.c2eb6368d408eb4e9ad609d6f34551ee'
  ];

  for (const urn of candidateUrns) {
    const encUrn = encodeURIComponent(urn);
    
    for (const qId of graphQlQueryIds) {
      urlTemplates.push((c, s) => `https://www.linkedin.com/voyager/api/graphql?includeWebMetadata=true&variables=(count:${c},start:${s},profileUrn:${encUrn})&queryId=${qId}`);
    }

    urlTemplates.push((c, s) => `https://www.linkedin.com/voyager/api/identity/profileUpdatesV2?count=${c}&includeLongTermCache=true&moduleKey=member-shares:phone&numComments=0&numLikes=0&profileUrn=${urn}&q=memberShareFeed&start=${s}`);
    urlTemplates.push((c, s) => `https://www.linkedin.com/voyager/api/identity/profileUpdatesV2?count=${c}&profileUrn=${urn}&q=memberShareFeed&start=${s}`);
    urlTemplates.push((c, s) => `https://www.linkedin.com/voyager/api/feed/updates?count=${c}&profileUrn=${urn}&q=memberShareFeed&start=${s}`);
  }

  if (profile.publicIdentifier) {
    urlTemplates.push((c, s) => `https://www.linkedin.com/voyager/api/identity/profiles/${encodeURIComponent(profile.publicIdentifier)}/profileUpdatesV2?count=${c}&q=memberShareFeed&start=${s}`);
  }

  urlTemplates.push((c, s) => `https://www.linkedin.com/voyager/api/feed/updates?count=${c}&start=${s}&q=memberShareFeed&moduleKey=member-shares:phone`);
  urlTemplates.push((c, s) => `https://www.linkedin.com/voyager/api/feed/updates?count=${c}&start=${s}&q=memberShareFeed`);

  const headerOptions = [
    {
      'csrf-token': sessionState.csrfToken,
      'x-restli-protocol-version': '2.0.0',
      'accept': 'application/vnd.linkedin.normalized+json+2.1, application/json;q=0.9',
      'x-li-lang': 'en_US'
    },
    {
      'csrf-token': sessionState.csrfToken,
      'accept': 'application/json',
      'x-li-lang': 'en_US'
    }
  ];

  while (hasMore && totalFetched < maxPosts) {
    const countToFetch = Math.min(pageSize, maxPosts - totalFetched);
    progressMessage.textContent = `Fetching via API (offset ${start})...`;
    updateProgress(totalFetched, maxPosts);

    let response = null;
    let json = null;

    if (successfulConfig) {
      const url = successfulConfig.urlTemplate(countToFetch, start);
      const res = await fetch(url, {
        method: 'GET',
        headers: successfulConfig.headers,
        credentials: 'include'
      });
      if (res.ok) {
        response = res;
        json = await res.json();
      }
    } else {
      outerLoop:
      for (const headers of headerOptions) {
        for (const tmpl of urlTemplates) {
          const url = tmpl(countToFetch, start);
          try {
            const res = await fetch(url, {
              method: 'GET',
              headers: headers,
              credentials: 'include'
            });

            if (res.ok) {
              const parsedJson = await res.json();
              const items = extractUpdatesList(parsedJson);
              if (items && items.length > 0) {
                response = res;
                json = parsedJson;
                successfulConfig = { urlTemplate: tmpl, headers: headers };
                break outerLoop;
              }
            }
          } catch (e) {
            // Continue testing
          }
        }
      }
    }

    if (!response || !json) {
      return false; // Fallback to Strategy 2
    }

    const updates = extractUpdatesList(json);
    if (!updates || updates.length === 0) {
      hasMore = false;
      break;
    }

    for (const rawUpdate of updates) {
      const parsed = parseLinkedInUpdate(rawUpdate, totalFetched + 1);
      if (parsed && (parsed.text || parsed.articleTitle)) {
        extractedPosts.push(parsed);
        totalFetched++;
        if (totalFetched >= maxPosts) break;
      }
    }

    start += updates.length;
    postCountBadge.textContent = `${totalFetched} Posts`;
    renderFormattedTextOutput();

    if (updates.length < countToFetch) {
      hasMore = false;
    }

    if (hasMore && totalFetched < maxPosts) {
      await sleep(500);
    }
  }

  return extractedPosts.length > 0;
}

/**
 * Strategy 2: Direct Page / Tab Extraction
 * Specifically targets your own authored posts (/recent-activity/posts/)
 */
async function fetchViaTabExtraction(maxPosts, scope = 'posts') {
  progressMessage.textContent = 'Navigating to your LinkedIn posts feed...';

  // Find or create LinkedIn tab
  const tabs = await chrome.tabs.query({ url: '*://*.linkedin.com/*' });
  let targetTab = tabs[0];

  const subPath = scope === 'shares' ? 'recent-activity/shares/' : (scope === 'all' ? 'recent-activity/all/' : 'recent-activity/posts/');
  
  // Prefer vanity username if available, otherwise universal /in/me/ redirect
  const activityUrl = sessionState.profile?.publicIdentifier 
    ? `https://www.linkedin.com/in/${sessionState.profile.publicIdentifier}/${subPath}`
    : `https://www.linkedin.com/in/me/${subPath}`;

  let tabCreated = false;

  if (!targetTab) {
    progressMessage.textContent = 'Opening your LinkedIn posts...';
    targetTab = await chrome.tabs.create({ url: activityUrl, active: false });
    tabCreated = true;
    await waitForTabLoad(targetTab.id);
  } else if (!targetTab.url.includes(subPath)) {
    progressMessage.textContent = 'Navigating to your published posts...';
    await chrome.tabs.update(targetTab.id, { url: activityUrl });
    await waitForTabLoad(targetTab.id);
  }

  progressMessage.textContent = 'Extracting your published posts...';
  updateProgress(25, 100);

  // Execute extraction script inside the LinkedIn tab
  const results = await chrome.scripting.executeScript({
    target: { tabId: targetTab.id },
    func: extractPostsFromPageDom,
    args: [maxPosts, scope, sessionState.profile?.fullName || '']
  });

  if (tabCreated) {
    chrome.tabs.remove(targetTab.id).catch(() => {});
  }

  if (results && results[0] && Array.isArray(results[0].result)) {
    const rawPosts = results[0].result;
    extractedPosts = rawPosts.map((p, idx) => ({
      index: idx + 1,
      urn: p.urn || '',
      url: p.url || '',
      publishedAt: p.time || 'Recent',
      rawTimestamp: null,
      mediaType: p.mediaType || 'text',
      articleTitle: p.articleTitle || '',
      articleUrl: p.articleUrl || '',
      text: p.text || ''
    }));

    postCountBadge.textContent = `${extractedPosts.length} Posts`;
  }
}

/**
 * Content Script function executed in the LinkedIn tab context to extract user's own posts
 */
async function extractPostsFromPageDom(maxPosts, scope, userFullName) {
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  const posts = [];
  const seenTexts = new Set();
  const seenUrns = new Set();

  let scrolls = 0;
  const maxScrolls = Math.max(8, Math.ceil(maxPosts / 2));
  let noNewPostCycles = 0;

  while (scrolls < maxScrolls && posts.length < maxPosts && noNewPostCycles < 4) {
    const previousLength = posts.length;

    // All post update cards on LinkedIn profile activity page
    const containers = document.querySelectorAll(
      '.feed-shared-update-v2, .feed-shared-update-v2__description-wrapper, div[data-urn*="activity"], div[data-id*="activity"], .profile-creator-shared-feed-update__container'
    );

    for (const container of containers) {
      if (posts.length >= maxPosts) break;

      // Extract URN and URL
      const rawUrn = container.getAttribute('data-urn') || container.getAttribute('data-id') || container.getAttribute('data-chameleon-urn') || '';
      let urn = '';
      if (rawUrn.includes('urn:li:activity:')) {
        const match = rawUrn.match(/urn:li:activity:[0-9]+/);
        if (match) urn = match[0];
      }
      if (!urn && rawUrn) urn = rawUrn;

      if (urn && seenUrns.has(urn)) continue;

      // Filter out non-authored activity (like comments on someone else's post)
      if (scope === 'posts') {
        const headerText = (container.querySelector('.feed-shared-header, .update-components-header')?.innerText || '').toLowerCase();
        if (headerText.includes('commented on') || headerText.includes('reacted to') || headerText.includes('likes this') || headerText.includes('celebrates')) {
          continue;
        }
      }

      // Click "...see more" buttons to expand truncated post text
      const seeMoreButtons = container.querySelectorAll(
        '.feed-shared-inline-show-more-text__see-more-less-toggle, button.see-more, button[aria-label*="see more"], .see-more'
      );
      for (const btn of seeMoreButtons) {
        try { btn.click(); } catch(e) {}
      }

      // Extract text content
      const textEl = container.querySelector(
        '.update-components-text, .feed-shared-update-v2__description, .feed-shared-text, .feed-shared-inline-show-more-text, .break-words'
      );
      let text = textEl ? textEl.innerText.trim() : '';

      // Skip duplicates
      if (!text || seenTexts.has(text)) continue;

      if (urn) seenUrns.add(urn);
      seenTexts.add(text);

      const url = urn ? `https://www.linkedin.com/feed/update/${urn}` : '';

      // Extract Actor / Time
      const timeEl = container.querySelector('.update-components-actor__sub-description, .feed-shared-actor__sub-description, time');
      const time = timeEl ? timeEl.innerText.split('\n')[0].trim() : '';

      // Extract attached article or document title
      const articleEl = container.querySelector('.feed-shared-article__title, .update-components-article__title, .feed-shared-document__title');
      const articleLink = container.querySelector('a.feed-shared-article__link, a.app-aware-link, a.feed-shared-document__link');

      posts.push({
        text: text,
        urn: urn,
        url: url,
        time: time,
        articleTitle: articleEl ? articleEl.innerText.trim() : '',
        articleUrl: articleLink ? articleLink.href : ''
      });
    }

    if (posts.length === previousLength) {
      noNewPostCycles++;
    } else {
      noNewPostCycles = 0;
    }

    // Smoothly scroll down for next batch
    window.scrollTo(0, document.body.scrollHeight);
    scrolls++;
    await sleep(850);
  }

  return posts;
}

/**
 * Helper to wait for tab loading completion
 */
function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 1400); // Give LinkedIn JS hydration 1.4s
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    // Timeout safeguard
    setTimeout(resolve, 8000);
  });
}

/**
 * Extract array of updates from Voyager response structure
 */
function extractUpdatesList(json) {
  if (Array.isArray(json.elements) && json.elements.length > 0) {
    return json.elements;
  }
  if (json.data && Array.isArray(json.data.elements) && json.data.elements.length > 0) {
    return json.data.elements;
  }
  if (Array.isArray(json.included)) {
    const updates = json.included.filter((item) => 
      item.$type && (
        item.$type.includes('Update') ||
        item.$type.includes('Share') ||
        item.$type.includes('ProfileUpdate')
      )
    );
    if (updates.length > 0) return updates;
  }
  if (Array.isArray(json.elements)) return json.elements;
  return [];
}

/**
 * Safely extracts text from deeply nested LinkedIn structures
 */
function findCommentaryText(obj) {
  if (!obj || typeof obj !== 'object') return '';
  if (typeof obj.commentary === 'string') return obj.commentary;
  if (obj.commentary?.text?.text) return obj.commentary.text.text;
  if (obj.commentary?.text && typeof obj.commentary.text === 'string') return obj.commentary.text;
  if (obj.share?.commentary?.text) return obj.share.commentary.text;
  if (obj.reshare?.commentary?.text) return `[Reshare] ${obj.reshare.commentary.text}`;
  if (obj.resharedUpdate?.commentary?.text?.text) return `[Reshare] ${obj.resharedUpdate.commentary.text.text}`;
  if (obj.text?.text) return obj.text.text;
  if (obj.description?.text) return obj.description.text;
  if (obj.value) return findCommentaryText(obj.value);
  if (obj.specificContent) return findCommentaryText(obj.specificContent);
  if (obj['com.linkedin.voyager.feed.render.UpdateV2']) return findCommentaryText(obj['com.linkedin.voyager.feed.render.UpdateV2']);
  if (obj['com.linkedin.voyager.feed.ShareUpdate']) return findCommentaryText(obj['com.linkedin.voyager.feed.ShareUpdate']);
  if (obj['com.linkedin.voyager.feed.ReshareUpdate']) return findCommentaryText(obj['com.linkedin.voyager.feed.ReshareUpdate']);
  return '';
}

/**
 * Safely traverses varying LinkedIn post payload structures
 */
function parseLinkedInUpdate(update, index) {
  if (!update) return null;

  let text = findCommentaryText(update);
  let timestamp = null;
  let postUrn = update.urn || update.entityUrn || '';
  let articleTitle = '';
  let articleUrl = '';
  let mediaType = 'text';

  // Extract article / link attachments
  const content = update.content || update.specificContent?.['com.linkedin.voyager.feed.ShareUpdate']?.share?.content;
  if (content) {
    const article = content['com.linkedin.voyager.feed.share.ArticleContent'] || content.article;
    if (article) {
      articleTitle = article.title || article.description?.text || '';
      articleUrl = article.navigationUrl || article.resolvedUrl || '';
      mediaType = 'article';
    }
  }

  // Extract timestamp
  if (update.created?.time) {
    timestamp = update.created.time;
  } else if (update.value?.['com.linkedin.voyager.feed.ShareUpdate']?.share?.created?.time) {
    timestamp = update.value['com.linkedin.voyager.feed.ShareUpdate'].share.created.time;
  } else if (update.actor?.subDescription?.text) {
    timestamp = update.actor.subDescription.text;
  }

  // Generate web URL for post
  let postUrl = '';
  if (postUrn) {
    postUrl = `https://www.linkedin.com/feed/update/${encodeURIComponent(postUrn)}`;
  }

  // Formatted date
  let formattedDate = 'Unknown date';
  if (typeof timestamp === 'number') {
    formattedDate = new Date(timestamp).toLocaleString('en-US', {
      timeZone: 'UTC',
      dateStyle: 'medium',
      timeStyle: 'medium'
    }) + ' UTC';
  } else if (typeof timestamp === 'string') {
    formattedDate = timestamp;
  }

  return {
    index: index,
    urn: postUrn,
    url: postUrl,
    publishedAt: formattedDate,
    rawTimestamp: timestamp,
    mediaType: mediaType,
    articleTitle: articleTitle,
    articleUrl: articleUrl,
    text: (text || '').trim()
  };
}

/**
 * Renders cleanly concatenated text into the textarea
 */
function renderFormattedTextOutput() {
  if (extractedPosts.length === 0) {
    outputArea.value = '';
    updateCharCount();
    enableExportButtons(false);
    return;
  }

  const divider = '='.repeat(60);
  const subDivider = '-'.repeat(60);

  const formattedBlocks = extractedPosts.map((post, i) => {
    let block = `${divider}\n`;
    block += `POST #${i + 1} | Published: ${post.publishedAt}\n`;
    if (post.url) {
      block += `URL: ${post.url}\n`;
    }
    if (post.urn) {
      block += `URN: ${post.urn}\n`;
    }
    if (post.articleTitle) {
      block += `ATTACHMENT: ${post.articleTitle} (${post.articleUrl})\n`;
    }
    block += `${subDivider}\n`;
    block += post.text ? post.text : '[No text content / Media only]';
    block += `\n${divider}\n`;
    return block;
  });

  outputArea.value = formattedBlocks.join('\n');
  updateCharCount();
  enableExportButtons(true);
}

/**
 * Updates character count indicator
 */
function updateCharCount() {
  const len = outputArea.value.length;
  charCount.textContent = `${len.toLocaleString()} chars`;
}

/**
 * Progress bar and percentage updater
 */
function updateProgress(current, total, isComplete = false) {
  if (isComplete || (total > 0 && current >= total)) {
    progressBar.style.width = '100%';
    progressPercent.textContent = '100%';
    return;
  }
  const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
  progressBar.style.width = `${pct}%`;
  progressPercent.textContent = `${pct}%`;
}

/**
 * Handle copy to clipboard
 */
async function handleCopyToClipboard() {
  if (!outputArea.value) return;

  try {
    await navigator.clipboard.writeText(outputArea.value);
    const originalText = copyBtn.textContent;
    copyBtn.textContent = '✓ Copied!';
    copyBtn.classList.add('btn-success');
    setTimeout(() => {
      copyBtn.textContent = originalText;
      copyBtn.classList.remove('btn-success');
    }, 2000);
  } catch (err) {
    alert('Failed to copy to clipboard: ' + err.message);
  }
}

/**
 * Download output as .txt file
 */
function handleDownloadTxt() {
  if (!outputArea.value) return;

  const dateStr = new Date().toISOString().slice(0, 10);
  const filename = `linkedin_my_posts_${dateStr}.txt`;
  downloadFile(outputArea.value, filename, 'text/plain;charset=utf-8');
}

/**
 * Download output as formatted .json file
 */
function handleDownloadJson() {
  if (extractedPosts.length === 0) return;

  const exportData = {
    exportedAt: new Date().toISOString(),
    exporter: 'PostScrapedIn v1.0',
    profile: sessionState.profile ? {
      fullName: sessionState.profile.fullName,
      headline: sessionState.profile.headline
    } : null,
    totalPosts: extractedPosts.length,
    posts: extractedPosts
  };

  const jsonStr = JSON.stringify(exportData, null, 2);
  const dateStr = new Date().toISOString().slice(0, 10);
  const filename = `linkedin_my_posts_${dateStr}.json`;
  downloadFile(jsonStr, filename, 'application/json;charset=utf-8');
}

/**
 * Clear output textarea and resets posts
 */
function handleClearOutput() {
  extractedPosts = [];
  outputArea.value = '';
  postCountBadge.textContent = '0 Posts';
  updateCharCount();
  enableExportButtons(false);
  progressMessage.textContent = 'Output cleared.';
  updateProgress(0, 1);
}

/**
 * Helper to trigger client-side file download via Blob URL
 */
function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function setFetchingUIState(fetching) {
  fetchBtn.disabled = fetching;
  if (postLimitSelect) postLimitSelect.disabled = fetching;
  if (postTypeSelect) postTypeSelect.disabled = fetching;
  if (fetching) {
    fetchBtnSpinner.style.display = 'inline-block';
    fetchBtnText.textContent = 'Fetching...';
  } else {
    fetchBtnSpinner.style.display = 'none';
    fetchBtnText.textContent = 'Fetch Posts';
  }
}

function enableExportButtons(enable) {
  copyBtn.disabled = !enable;
  downloadTxtBtn.disabled = !enable;
  downloadJsonBtn.disabled = !enable;
  clearBtn.disabled = !enable;
}

function updateStatus(text, type) {
  sessionStatusText.textContent = text;
  statusDot.className = `status-dot ${type}`;
}

function showAuthError(message) {
  updateStatus('Offline / Not Logged In', 'offline');
  authErrorBanner.classList.remove('hidden');
  profileName.textContent = 'LinkedIn Session Not Detected';
  profileHeadline.textContent = message || 'Please log into linkedin.com';
  fetchBtn.disabled = true;
}

function hideAuthError() {
  authErrorBanner.classList.add('hidden');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
