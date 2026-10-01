/**
 * background.js - Service Worker for PostScrapedIn
 * Handles cookie extraction for LinkedIn authentication offline and client-side.
 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'GET_LINKEDIN_SESSION') {
    getLinkedInSession()
      .then((session) => sendResponse({ success: true, data: session }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true; // Keep channel open for async response
  }
});

/**
 * Retrieves essential authentication cookies (li_at and JSESSIONID)
 * from linkedin.com.
 */
async function getLinkedInSession() {
  const cookieStores = await chrome.cookies.getAll({ domain: 'linkedin.com' });

  const liAtCookie = cookieStores.find((c) => c.name === 'li_at');
  const jsessionIdCookie = cookieStores.find((c) => c.name === 'JSESSIONID');

  if (!liAtCookie || !liAtCookie.value) {
    throw new Error('Not logged into LinkedIn. Please log into LinkedIn in your browser.');
  }

  if (!jsessionIdCookie || !jsessionIdCookie.value) {
    throw new Error('LinkedIn session CSRF token (JSESSIONID) not found.');
  }

  // LinkedIn JSESSIONID is typically surrounded by quotes, e.g. "ajax:123456789"
  // For the csrf-token header, quotes must be stripped.
  const rawCsrf = jsessionIdCookie.value;
  const csrfToken = rawCsrf.replace(/^"|"$/g, '');

  return {
    isLoggedIn: true,
    csrfToken: csrfToken,
    liAt: liAtCookie.value,
    domain: liAtCookie.domain,
    secure: liAtCookie.secure
  };
}
