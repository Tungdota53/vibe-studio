# Chờ và phục hồi runtime

Model stream kết thúc ngay khi nhận `[DONE]`, kể cả khi gateway giữ HTTP mở.
Dữ liệu sau dấu này bị bỏ qua. Các retry và backoff dùng chung thời hạn
một yêu cầu, mặc định tối đa 180 giây, thay vì mỗi retry có thêm 180 giây.
Nếu không nhận dữ liệu trong 60 giây, request bị hủy. Luồng có phản hồi một
phần giữ cơ chế tiếp tục cùng model và chống phát lại công cụ đã hoàn tất.

Sơ đồ Teamwork cập nhật hoạt động khi thực sự nhận đoạn text hoặc tool-call
từ model. Heartbeat và trạng thái đang chạy không chứng minh nghiệm thu.

Agent không xóa lịch sử cùng lỗi công cụ chỉ vì vừa ghi tệp. Kết quả lỗi
thay đổi vẫn được phân biệt để tránh chặn các thử nghiệm có bằng chứng mới.
Runtime phát hiện bốn lần ghi không tạo thay đổi và bốn lần quay lại cùng
hash nguồn sau các sửa đổi qua lại. Các thay đổi khác nhau và công việc
có tiến triển vẫn được phép vượt các giới hạn lượt cũ.

Các bảo vệ này giữ checkpoint và chỉ rõ nguyên nhân không tiến triển.
Chúng không bảo đảm mọi nhà cung cấp model, MCP hoặc dự án bên ngoài sẽ
không gặp lỗi. Kiểm thử toàn bộ, kiểm tra desktop và EXE là kết quả trên
cấu hình kiểm tra; chúng không thay thế log của một sự cố production mới.
