# Trung tâm điều hành Vibe Studio

Mở **Công cụ phiên** để xem điều hành Teamwork, lỗi gốc, bộ nhớ dự án, lịch sử và nguồn skill. Mục này sử dụng checkpoint, journal và kết quả công cụ thật của phiên.

## Điều chỉnh trong phiên

- **Gửi điều chỉnh** áp dụng cho task đang chạy hoặc chưa chạy, từ lượt model tiếp theo. Nếu yêu cầu đến khi model đang trả lời lượt cuối, runtime giữ câu trả lời đó trong lịch sử và thực hiện thêm lượt xử lý yêu cầu mới. Không gọi lại planner.
- Task đã hoàn tất được giữ. Điều chỉnh được thêm làm tiêu chí mới cho task chưa xong và các task phụ thuộc, không tự mở rộng phạm vi tệp, không sửa tiêu chí cũ hay cấp thêm quyền. Muốn thay đổi phần đã hoàn tất hoặc mở rộng dự án, tạo yêu cầu mới với phạm vi rõ ràng.
- **Ưu tiên task** chỉ thay đổi thứ tự giao task sẵn sàng; vẫn giữ dependency và khóa quyền ghi.
- **Tạm ngừng giao việc** ngừng phát task mới. Các agent đã chạy tiếp tục hoàn tất; nút dừng phiên vẫn hủy tiến trình theo cơ chế hiện có.
- Điều chỉnh được lưu ở `.vibe/sessions/<id>/adjustments.json`, được nạp lại khi tiếp tục phiên.

## Cách ly và xung đột

Bật worktree trong Công cụ phiên cho lượt chạy mới. Dự án Git cần commit và nguồn sạch. Worker cùng phiên dùng một bản triển khai cách ly để tester/reviewer kiểm tra cùng nguồn. Dự án không có Git giữ cơ chế thư mục chung.

Các worker có tệp trùng phải chờ quyền ghi. Tên Windows mơ hồ, đường dẫn nội bộ và thiết bị hệ thống bị từ chối trong kế hoạch. Trước công cụ ghi/shell của worker, runtime so sánh hash các tệp được giao. Nếu tệp đã đổi ngoài agent, app từ chối ghi; agent phải đọc nguồn mới để điều hòa thay đổi.

**Tích hợp bản đã nghiệm thu** chỉ nhận phiên hoàn tất có gate PASS, fingerprints coder hiện hành và bằng chứng kiểm tra chưa cũ. App kiểm tra toàn bộ tệp dự án với baseline trước khi bắt đầu sao chép. Thay đổi người dùng gây conflict, giữ nguyên dự án. Tích hợp tạo checkpoint để hoàn tác từng tệp. Tệp ngoài phạm vi được giao không được tự tích hợp.

Khóa quyền ghi và kiểm tra hash không phải sandbox hệ điều hành cho shell. Lệnh dự án vẫn cần được chọn đúng phạm vi; cơ chế nghiệm thu kiểm tra nguồn và bằng chứng độc lập.

## Ghi nhớ, lịch sử và bàn giao

- Ghi nhớ quyết định cùng 1–40 tệp nguồn. App lưu SHA-256 và tự loại khỏi recall khi nguồn đổi, mất hoặc không đọc được.
- Bản sửa chỉ được học tự động khi gate PASS, có repair coder hoàn tất, nguồn hiện hành và kết quả lệnh kiểm tra thành công. Chưa học bản sửa còn nằm trong worktree chưa tích hợp.
- Ghi nhớ được đưa vào task như bằng chứng lịch sử cần kiểm tra, không thay đổi quyền agent. Tối đa 100 mục và khoảng 1 MiB trên dự án.
- Timeline có trạng thái pipeline, agent/model, tham số đường dẫn/lệnh, kết quả công cụ và checkpoint. Xem lịch sử không chạy lại thao tác.
- Xuất hồ sơ tạo `DELIVERY.md` và `delivery.json` cùng thư mục phiên; JSON có trạng thái, bằng chứng, quan sát preview và diff. Export giới hạn 500 sự kiện, 30 checkpoint, 40 tệp/checkpoint và 2.000 ký tự mỗi phía diff; checkpoint gốc vẫn nằm trên máy.

## Preview và chế độ

Preview có chế độ rộng 320px, kiểm tra DOM cho tràn ngang, ảnh lỗi, ảnh thiếu alt và điều khiển thiếu tên. Đây là các ứng viên cần xem xét, không thay bộ test browser. Bản EXE chụp vùng preview ra `.vibe/preview-snapshots`; quan sát lưu cùng hash HTML đầu vào. Hash này không bao phủ toàn bộ CSS/JS.

Chat có các chế độ Hỏi, Lập kế hoạch, Triển khai, Kiểm chứng và Chẩn đoán/sửa. Runtime chọn role và quyền tương ứng: Hỏi không chạy shell/ghi; Lập kế hoạch không sửa nguồn; Kiểm chứng chạy kiểm tra nhưng không được sửa source. Hai chế độ triển khai/sửa sử dụng coder.

Ước lượng hiển thị số task, tệp và slot từ kế hoạch. Khoảng token/thời gian chỉ hiện khi có telemetry trước; chi phí cần đơn giá đã cấu hình. Đây là khoảng tham khảo, không cam kết thời gian hoàn tất.

## Kiểm tra phát hành

`npm run desktop:release:check` chạy build, toàn bộ test, Electron UI smoke, đóng gói Setup/Portable và kiểm tra EXE đã đóng gói. Nếu một bước lỗi, pipeline dừng trước phát hành. Script kiểm tra nguồn không đổi trong quá trình chạy, tạo checksum và `release/preflight.json`. Không tự upload hoặc thay đổi release GitHub.
