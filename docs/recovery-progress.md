# Phục hồi Teamwork theo bằng chứng

Khi kiểm thử hoặc review thất bại, Vibe thu thập kết quả của các validator
đang chạy trước khi sửa nguồn. Một phiên giữ cùng lịch sử phục hồi qua các
nhóm lỗi, tên lệnh, thay đổi mã và thao tác tiếp tục.

Các chiến lược lần lượt là sửa trực tiếp, chẩn đoán nguyên nhân, tái hiện tối
thiểu và thử cách triển khai khác. Mỗi chiến lược có hai lượt. Thay đổi nhóm
validator hoặc thêm tùy chọn `--quiet` không đặt lại lịch sử. Checkpoint cũ
được đối chiếu cả số vòng sửa đã lưu để tránh bắt đầu lại từ đầu.

Trong sơ đồ agent, bấm vào thanh thông tin pipeline để xem **Phục hồi theo
bằng chứng**. Mỗi lần đánh giá ghi lại:

- Kiểm thử thực tế chuyển từ lỗi sang đạt và kiểm thử bị hồi quy.
- Lỗi mới, lệnh vẫn thất bại và chiến lược phục hồi tiếp theo.
- Token thực tế, token ước lượng, số lượt model thiếu usage và chi phí nếu
  đã có đủ bảng giá cùng usage. Thiếu dữ liệu không được hiển thị thành $0.

Nguồn thay đổi, số finding giảm hoặc tên kiểm thử đổi chưa chứng minh lỗi đã
được sửa. Lịch sử này được lưu trong `resume.json` và `pipeline.json` của
phiên. App giữ kế hoạch và checkpoint khi cần bổ sung môi trường hoặc bằng
chứng. Không tự phát lại thao tác ghi có kết quả chưa rõ.

Các lệnh chính xác tìm Chrome/Edge (`where chrome`, `where msedge` và cặp
lệnh này) là kiểm tra môi trường, không phải bằng chứng browser E2E. Nếu
được khai báo trong hợp đồng kiểm thử bắt buộc, chúng vẫn chặn nghiệm thu
khi thất bại. Browser chưa chạy vẫn **UNVERIFIED**. Kiểm thử ứng dụng,
`npm audit`, timeout và lệnh shell khác vẫn được kiểm chứng bình thường.

Hướng dẫn sửa lỗi cấm ngoại lệ theo fixture, tên tệp hoặc call stack, bypass
bằng trạng thái toàn cục và làm yếu bảo mật để đạt test. Đây là hướng dẫn
cho agent; review và kiểm thử độc lập vẫn phải phát hiện các bypass thực tế.
