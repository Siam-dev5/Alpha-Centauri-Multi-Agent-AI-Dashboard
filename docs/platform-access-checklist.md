# External platform access checklist

This checklist identifies owner actions required before real integrations can be enabled. Never paste client secrets or access tokens into chat or commit them to Git.

## Meta — Facebook Pages / Instagram
- Create or select a Meta Developer App.
- Add Facebook Login / Instagram API products appropriate to the chosen account login model.
- Facebook Page publishing requires an eligible Page task and permissions such as pages_show_list, pages_read_engagement and pages_manage_posts.
- Instagram publishing requires a Professional Business or Creator account and the applicable Instagram publishing permission. Select Instagram Login or Facebook Login deliberately; they have different permission and account-linking models.
- Complete App Review / Business Verification where Meta requires it.
- Official docs: https://developers.facebook.com/docs/graph-api/reference/page/feed/
- Instagram API changelog and login model: https://developers.facebook.com/docs/instagram/platform/instagram-api/changelog/

## Google / YouTube
- Create/select a Google Cloud project and enable YouTube Data API v3.
- Configure OAuth consent screen and OAuth client.
- Uploads and private channel access require OAuth 2.0. The youtube.upload scope is relevant for uploads; an API key alone is insufficient.
- Official docs: https://developers.google.com/youtube/data/guides/authentication
- Upload endpoint: https://developers.google.com/youtube/v3/docs/videos/insert

## TikTok
- Create a TikTok for Developers app and add Content Posting API.
- Request and obtain approval for video.publish and obtain each creator's authorization.
- Complete the Content Posting API audit to remove private-only restrictions for unaudited clients.
- Official docs: https://developers.tiktok.com/docs/en/content-posting-api-get-started
- Direct Post: https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post

## Shopee Affiliate Thailand
- Affiliate Open API access is subject to Shopee's review process; the Thai help page describes eligibility signals including more than 1,000 affiliate orders/month, a proper website or substantial social reach, and quality content.
- Seller Open API credentials are not interchangeable with Affiliate Open API access.
- Apply through the official Affiliate Open API process: https://help.shopee.co.th/portal/4/article/198622-%E0%B8%82%E0%B8%B1%E0%B9%89%E0%B8%99%E0%B8%95%E0%B8%AD%E0%B8%99%E0%B8%81%E0%B8%B2%E0%B8%A3%E0%B8%82%E0%B8%AD%E0%B9%80%E0%B8%9B%E0%B8%B4%E0%B8%94-Affiliate-Open-API
- Do not enable API reporting until approval and current endpoint documentation are confirmed.

## Lazada Affiliate
- Confirm the current Thailand Affiliate/Publisher API program and account eligibility with Lazada's official affiliate partner portal.
- Do not substitute Seller Center API credentials or invent endpoints.
- Enable link generation and reporting only after official access is granted and tested.

## Secret handling
- Store credentials in the local machine's .env or a secrets manager.
- Use a unique encryption key for token-at-rest encryption.
- Never upload .env, client secrets, refresh tokens or access tokens to GitHub or chat.
