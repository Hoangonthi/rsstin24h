# Daily News Archive

Firestore giữ tin trong 48 giờ gần nhất. Tin có `publishedAt` cũ hơn 48 giờ
sẽ được xuất ra file text trong `archives/` rồi xóa khỏi Firestore.

## Chạy xuất file

```powershell
npm run archive:daily
```

File xuất ra có dạng:

```text
archives/news-2026-05-26.txt
```

`npm run rss` cũng tự chạy bước archive ở đầu watcher, trừ khi đặt:

```powershell
$env:WATCHER_SKIP_ARCHIVE="true"
```

Muốn đổi thời gian giữ tin:

```powershell
$env:ARCHIVE_RETENTION_HOURS="72"
npm run archive:daily
```

## Gửi mail

Cài đặt các biến môi trường SMTP trước khi chạy:

```powershell
$env:SMTP_HOST="smtp.gmail.com"
$env:SMTP_PORT="587"
$env:SMTP_USER="your-email@gmail.com"
$env:SMTP_PASS="your-app-password"
$env:ARCHIVE_MAIL_TO="vvhoangvn@gmail.com"
npm run archive:daily:email
```

Không lưu mật khẩu SMTP vào source code.
