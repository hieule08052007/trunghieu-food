TRUNGHIEU FOOD - HỆ THỐNG ĐẶT BÀN BẢN ỔN ĐỊNH

BẢN NÂNG CẤP
- Node.js server có health check, giới hạn request và bảo vệ admin.
- Phiên admin dùng cookie ký bằng SESSION_SECRET, không phụ thuộc RAM của server.
- Hỗ trợ PostgreSQL qua biến môi trường DATABASE_URL để dữ liệu không phụ thuộc filesystem của hosting.
- Có fallback data/bookings.json để chạy local/test khi chưa có DATABASE_URL.
- Có index cho ngày, trạng thái và thời gian tạo để truy vấn admin nhanh hơn.

CHẠY LOCAL
1) Cài Node.js LTS.
2) Mở Terminal tại thư mục project.
3) Chạy: npm install
4) Chạy: npm start
5) Mở: http://localhost:3000
6) Admin: http://localhost:3000/admin

BIẾN MÔI TRƯỜNG KHI DEPLOY
ADMIN_PASSWORD = mật khẩu admin mạnh
SESSION_SECRET = chuỗi bí mật dài, ngẫu nhiên
DATABASE_URL = connection string PostgreSQL
NODE_ENV = production
PORT = hosting tự cấp, không cần tự đặt

QUAN TRỌNG
- Không đưa .env, mật khẩu hoặc DATABASE_URL vào GitHub.
- Khi dùng hosting, hãy dùng PostgreSQL thay cho data/bookings.json.
- Bản này chưa có thanh toán, email/SMS tự động hoặc chống bot CAPTCHA; có thể bổ sung sau.
