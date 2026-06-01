# Firestore manual_news rules notes

## Access patterns

- Public dashboard reads `manual_news` with `status == "published"` ordered by `publishedAt desc`.
- Admin/dev board reads all `manual_news` ordered by `publishedAt desc`.
- Admin/dev board creates, updates, hides, publishes, and deletes manual news.
- Duplicate checks query `manual_news.url` and `news.url/canonicalUrl/originalUrl/link`.

## Data model

`manual_news/{newsId}` stores a manually curated news link with URL, title, source, timestamps, summary/content, tickers, sectors, analysis fields, admin note, status, and creator email.

## Devil's advocate checks

- Public list exploit: rules only allow reads when the returned document has `status == "published"` unless the user is an admin.
- Unauthorized write: create/update/delete require the bootstrapped admin email.
- Update bypass/schema pollution: create and update both call `isValidManualNews`, which limits allowed fields, string sizes, list sizes, and enum values.
- Ownership/creator tampering: `createdAt` and `createdBy` are immutable after create; create requires `createdBy` to match the admin email.
- Query mismatch: public and admin queries are supported by rules, and the `status,publishedAt` composite index is declared.
