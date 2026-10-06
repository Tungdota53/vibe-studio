# Tác vụ nền

Trên thanh công cụ Vibe, chọn **Tác vụ nền**. Có thể chạy server/CLI trong
workspace, xem log, PID, trạng thái và exit code, kiểm tra HTTP loopback,
hoặc dừng process cùng process con. Lệnh chạy thủ công có thời hạn 10 phút.

Agent có các công cụ `start_background`, `list_background`,
`background_status`, `check_background_health` và `stop_background`.
Khởi chạy trả về ngay; browser test dùng URL của server sau khi kiểm tra
sẵn sàng. Không dùng lệnh kiểm thử đồng bộ để chờ dev server mãi mãi.

Process gắn với phiên và có thể được tester cùng phiên sử dụng. Agent
không được dừng process của phiên khác. Planner, reviewer, judge và nhiệm
vụ chỉ đọc không được khởi chạy hoặc dừng process. Người dùng có thể dừng
process từ bảng điều khiển workspace. Khi phiên kết thúc, bị hủy, app đóng
bình thường hoặc hết thời hạn, runtime thu hồi process thuộc quyền quản lý.

Windows chạy process với `windowsHide`; đây là chế độ nền cho CLI/server,
không đảm bảo ẩn cửa sổ của mọi ứng dụng có giao diện. Điều khiển ứng dụng
khác vẫn cần MCP/API/automation chuyên dụng. Vibe đã hỗ trợ MCP local qua
stdio và MCP từ xa qua HTTP; tính năng này không tự cài một dịch vụ bên
thứ ba hoặc cấp quyền điều khiển mọi ứng dụng.

Log lưu trong bộ nhớ, có giới hạn kích thước và che các mẫu bí mật đã nhận
diện. Khởi chạy trùng lệnh trong cùng phiên trả process hiện có. Lệnh tách
process bằng `cmd start`, `Start-Process`, `nohup` hoặc `setsid` bị từ chối
để giữ khả năng thu hồi. Không bảo đảm thu hồi khi hệ điều hành buộc tắt
app hoặc chương trình tự tạo daemon nằm ngoài cây process quản lý.

Process đang chạy và HTTP 200 là bằng chứng **sẵn sàng**, không phải bằng
chứng kiểm thử thành công. Vẫn cần chạy bộ kiểm thử và review độc lập.
