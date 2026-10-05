# Vibe Studio 1.0

Không gian làm việc AI trên Windows để trò chuyện với dự án, viết mã và phối hợp nhiều agent. Vibe Studio kết hợp chat, quản lý ngữ cảnh, công cụ lập trình và sơ đồ tác vụ trong một ứng dụng desktop.

[Tải Vibe Studio 1.0](https://github.com/Tungdota53/cutty-studio/releases/tag/v1.0.0) · [Mã nguồn](https://github.com/Tungdota53/cutty-studio)

![Giao diện theo dõi agent](docs/agent-map-preview.png)

## Tính năng

### Chat và làm việc với dự án

- Chọn thư mục dự án, tạo chat và mở lại lịch sử đã lưu.
- Nhận phản hồi trực tiếp khi AI đang trả lời; dừng tác vụ ngay trên giao diện.
- Theo dõi tiến độ ngay trong chat: công cụ đang chạy, bước đã xong và lỗi cần xử lý; mở lại phiên để xem các mốc đã lưu.
- Trong phiên Teamwork cũ, gõ “tiếp tục” để khôi phục kế hoạch và checkpoint, giữ kết quả hợp lệ và chạy phần còn lại. App không gọi planner tạo kế hoạch mới; nếu chưa chọn phiên hoặc nguồn đã thay đổi, app báo nguyên nhân cần xử lý.
- Phục hồi nhận diện các vòng sửa hoàn tất kế tiếp trên cùng nhóm tệp: dấu vết vòng sửa mới thay thế vòng cũ để xác minh nguồn, vẫn giữ lịch sử. Thay đổi ngoài phiên bị chặn; bằng chứng kiểm tra cũ được chạy lại khi nguồn đã được sửa hợp lệ.
- Sơ đồ phân biệt heartbeat và tiến độ thực tế, hiển thị thời điểm cập nhật gần nhất và cảnh báo khi chưa có kết quả mới sau 90 giây. Lệnh shell quá 2 phút, bộ kiểm thử quá 5 phút hoặc thao tác Git quá 30 giây sẽ dừng cây tiến trình được app khởi tạo; giữ checkpoint để kiểm tra thay đổi trước khi thử lại.
- Câu trả lời có tiêu đề, danh sách, bảng, màu code và hiệu ứng streaming; sao chép toàn bộ câu trả lời hoặc từng khối code.
- Đọc, tìm kiếm và chỉnh sửa tệp, xem Git diff, chạy lệnh và kiểm thử theo quyền của agent.
- Kết nối nhà cung cấp API tương thích OpenAI bằng URL, khóa API và tên model.
- Chọn chế độ Hỏi, Lập kế hoạch, Triển khai, Kiểm chứng hoặc Chẩn đoán/sửa; runtime áp dụng quyền theo chế độ.

### Trung tâm điều hành phiên

- Bổ sung yêu cầu trong lúc Teamwork chạy, ưu tiên task chưa chạy và tạm ngừng giao việc; giữ kế hoạch và kết quả đã hoàn tất.
- Xem lỗi gốc, lần tự phục hồi, kiểm tra thất bại và task đang chờ kết quả.
- Lưu ghi nhớ cùng hash tệp nguồn; loại khỏi context khi nguồn đổi. Học các bản sửa đã nghiệm thu với bằng chứng kiểm tra thực thi.
- Xem timeline agent/model/lệnh/kết quả và diff theo checkpoint; xuất hồ sơ bàn giao Markdown/JSON.
- Bật worktree cách ly cho dự án Git sạch. Tích hợp tệp đã nghiệm thu PASS sau khi kiểm tra xung đột với thay đổi người dùng, có checkpoint hoàn tác.
- So sánh nguồn trước công cụ ghi của worker, giữ khóa tệp theo task và từ chối tên tệp Windows mơ hồ.
- Hiển thị phạm vi kế hoạch; ước lượng token/thời gian từ telemetry trước, chi phí từ đơn giá được cấu hình.
- Xem nguồn, commit, giấy phép, integrity và runtime cần thiết của skill trong Công cụ phiên.

[Quy trình và giới hạn của trung tâm điều hành](docs/operations-center.md).

### Teamwork chạy song song

- Phân công công việc cho các agent lập kế hoạch, lập trình, kiểm thử, rà soát và nghiệm thu.
- Agent có nhiệm vụ độc lập chạy đồng thời; số agent đang hoạt động có thể cấu hình từ 1 đến 16.
- Mỗi tác vụ có người phụ trách, tệp được giao, tiêu chí nghiệm thu và quan hệ phụ thuộc.
- Nhánh độc lập tiếp tục khi nhánh khác lỗi; tác vụ cần kết quả còn thiếu hiển thị rõ lý do bị chặn.
- Phục hồi thích ứng lưu cách sửa đã thất bại và đổi chiến lược: sửa trực tiếp → chẩn đoán nguyên nhân → tái hiện tối thiểu → triển khai thay thế. Chẩn đoán chỉ đọc cần bằng chứng kiểm tra nguồn thật trước khi truyền sang coder. Trạng thái chiến lược được giữ khi tiếp tục phiên.
- Agent vẫn làm việc song song; lệnh shell/test dùng chung workspace được xếp hàng để tránh nhiều build ghi đè `.next` hoặc output của nhau. Khi chờ, app không gọi model và sơ đồ hiển thị lý do.
- Lần chạy mới nhất của cùng lệnh quyết định kết quả; lịch sử lỗi cũ được giữ. Tìm kiếm không có kết quả và dò runtime tùy chọn không bị coi là kiểm thử thất bại; lệnh bắt buộc và audit lỗ hổng thật vẫn chặn.
- Pipeline tự thử lại lỗi kết nối/stream tạm thời từ checkpoint, giữ kết quả công cụ đã chạy. Lỗi kiểm thử được gom để agent sửa và chạy lại các bước liên quan; không còn trần hai vòng nếu mã nguồn còn tiến triển. Lỗi lặp chuyển sang chiến lược phục hồi khác; chỉ yêu cầu hỗ trợ khi các hướng được phép đều thất bại hoặc thiếu bằng chứng/phạm vi sửa. Audit dependency có thể tạo tác vụ sửa package/lock và reviewer độc lập khi kế hoạch ban đầu chỉ gồm kiểm tra. Ngân sách, lỗi quyền truy cập, xung đột nguồn và thao tác chưa rõ kết quả vẫn được bảo vệ. Công cụ `write_report` cho phép lưu JSON trong `test-results/` hoặc `reports/`, có checkpoint và không cấp quyền sửa mã nguồn cho tester/reviewer. Kết quả audit có lỗ hổng chưa xử lý vẫn chặn nghiệm thu.
- Nghiệm thu phân biệt dò phiên bản/import môi trường và thao tác lưu báo cáo với kiểm thử bắt buộc. Agent dùng runtime và test script của dự án; Node Playwright không yêu cầu Python. Lịch sử thử nghiệm của coder được giữ để tra cứu; kết luận dựa vào lệnh bắt buộc và tester/reviewer kiểm tra nguồn cuối. Timeout và kiểm thử thật thất bại vẫn chặn, kèm tên lệnh và nguyên nhân.

### Sơ đồ agent trực tiếp

- Hiển thị agent, model đang gọi, nhiệm vụ, bước hiện tại và trạng thái chạy/chờ/hoàn tất/lỗi.
- Xem danh sách agent hoạt động hoặc đồ thị phụ thuộc giữa các tác vụ.
- Bấm tác vụ để xem skill, tệp được giao, kết quả và nhật ký hoạt động.
- Phóng to, thu nhỏ, vừa khung và theo dõi tác vụ đang chạy.
- Giao diện tối với chuyển động và hỗ trợ giảm chuyển động theo hệ điều hành.

### Thiết lập agent và skill

- Chọn model, hướng dẫn, vai trò và skill riêng cho từng agent; bật hoặc tắt agent theo dự án.
- Có 7 skill vai trò và 38 gói skill bổ sung cho lập trình, UI/UX, bảo mật, kiểm thử, nghiên cứu và phối hợp tác vụ.
- Tự đề xuất skill theo vai trò/chủ đề hoặc chọn thủ công.
- Kiểm tra nguồn, giấy phép và tính toàn vẹn của các gói skill đóng sẵn trước khi nạp.
- Đọc tài liệu web HTTPS công khai bằng công cụ nghiên cứu tích hợp.

### Ngữ cảnh và phục hồi

- Lưu lịch sử, lời gọi công cụ và kết quả theo từng cuộc trò chuyện.
- Chế độ tự động dùng cửa sổ context do nhà cung cấp công bố; có giới hạn thủ công/dự phòng khi API thiếu metadata.
- Context dự phòng mặc định **1.000.000 token**, tự nâng cấu hình auto cũ; dùng giới hạn thực tế khi API công bố và giữ cấu hình thủ công. Bảng ngữ cảnh phân biệt cửa sổ hiệu lực, ngân sách đầu vào và phần dành cho đầu ra.
- Hiển thị dung lượng ước tính, token đầu vào/đầu ra và số lần nén; hỗ trợ nén thủ công.
- Nén lịch sử cũ khi cần, giữ yêu cầu và tra cứu lại bản ghi gốc của tác vụ.
- Đặt ngân sách lượt suy luận và lượt công cụ về **0** để không giới hạn số lượt; nút Dừng và kiểm tra lặp không tiến triển vẫn hoạt động.
- Khi stream bị ngắt, tiếp tục trên cùng model với tối đa hai lần phục hồi; giữ checkpoint và loại bỏ lời gọi công cụ chưa hoàn chỉnh.
- Trong **Công cụ phiên**, ghim yêu cầu và thêm tệp nguồn vào context; xem nguồn, nhóm lượt và lượng token ước tính. Ghi nhớ được giữ qua các lần nén.
- Checkpoint tự lưu trước/sau chỉnh sửa tệp; xem diff, chọn tệp hoàn tác và kiểm tra xung đột với thay đổi mới của bạn. Snapshot lệnh có phạm vi và dung lượng giới hạn, hiển thị phần không được lưu.
- Tiếp tục chat hoặc Teamwork bị gián đoạn từ nhật ký lưu trên máy. Task hoàn tất được giữ khi dấu vết tệp còn đúng; thao tác ghi chưa xác định kết quả được đánh dấu để kiểm tra.
- Đặt ngân sách token và USD cho mỗi agent/task, xem thời gian, số lượt gọi và cảnh báo từ 80%. Giá tính theo đơn giá bạn nhập; chưa có giá được hiển thị rõ. Giới hạn được kiểm tra trước lượt gọi tiếp theo.

### Preview web cạnh chat

- Mở tệp HTML trong workspace để xem cùng CSS/JavaScript trên bảng preview riêng; tự tải lại khi tệp web thay đổi.
- Hiển thị console, lỗi JavaScript và promise bị từ chối; hỗ trợ tải lại thủ công.
- Kiểm tra bố cục 320px, phát hiện ứng viên tràn ngang/ảnh lỗi/thiếu nhãn và chụp vùng preview trong bản EXE. Quan sát lưu cùng hash HTML, cần bộ test browser để nghiệm thu luồng người dùng.
- Preview chạy trong iframe cô lập, không có quyền truy cập backend và chặn tệp bí mật/nội bộ. Preview hiện hỗ trợ dự án web tĩnh; ứng dụng cần dev server phải build ra HTML trước.

### Kết nối nhiều MCP

- Mục **Tích hợp dự án** nhận diện công nghệ từ manifest, đề xuất skill/MCP và tự thiết lập trước khi agent làm việc. Có thể bật/tắt, thiết lập ngay hoặc dừng tải.
- Tải skill từ danh mục nguồn GitHub đã kiểm tra, cố định commit, xác minh checksum và giấy phép; tải cả tài nguyên và gán cho vai phù hợp. Cache đã xác minh được tái sử dụng.
- Dự án web được chọn Playwright MCP; dự án có thư viện được chọn Context7. Playwright cài riêng trong `.vibe/integrations`, cố định phiên bản npm và bỏ install scripts; cần npm và trình duyệt trên máy.
- Hiển thị kết quả tải và số công cụ thực sự kết nối. Server thiếu khóa, thiếu runtime hoặc lỗi mạng được báo riêng và không chặn agent dùng công cụ hiện có. Không tự thu thập mọi kho tùy ý hay gọi nguồn đó là có chứng chỉ.

- Thêm nhiều server trong mục **MCP**, hỗ trợ Streamable HTTP và chương trình Stdio chạy trên máy.
- Xem trạng thái kết nối và số công cụ của từng server; bật/tắt hoặc xóa từng cấu hình.
- Agent tự thấy và gọi các công cụ được phép, với tên riêng theo server để tránh trùng.
- Các agent chạy song song có thể dùng nhiều server đồng thời; lỗi của một kết nối được giữ riêng.
- Công cụ MCP được lọc theo vai trò và tính chất chỉ đọc. Tác vụ ghi không tự được gửi lại khi lỗi kết nối.
- Chỉ nạp nhóm công cụ phù hợp nhiệm vụ trong ngân sách schema; agent tìm và kích hoạt thêm khi cần. Tra cứu công cụ từ **Công cụ phiên**.

## Tải và bắt đầu

Mở [trang tải Vibe Studio 1.0](https://github.com/Tungdota53/cutty-studio/releases/tag/v1.0.0), chọn bản dành cho **Windows x64**:

| Tệp | Cách dùng |
| --- | --- |
| `Vibe-Studio-1.0.0-x64-Setup.exe` | Cài đặt ứng dụng và tạo shortcut |
| `Vibe-Studio-1.0.0-x64-Portable.exe` | Chạy trực tiếp, không cần cài đặt |
| `SHA256SUMS-1.0.0.txt` | Đối chiếu checksum của các tệp tải xuống |

1. Mở ứng dụng và chọn thư mục dự án.
2. Vào **Cài đặt**, nhập URL API, khóa API và tên model của nhà cung cấp.
3. Chọn context tự động hoặc nhập giới hạn thực tế của model.
4. Trò chuyện trực tiếp hoặc chọn **Teamwork** để giao việc cho nhóm agent.
5. Mở **Thiết lập agent** để chỉnh model, skill và số agent chạy đồng thời.

Ứng dụng đi kèm runtime nên không cần cài Node.js để mở app. Dự án vẫn cần các công cụ tương ứng như Git, npm hoặc Python khi tác vụ sử dụng chúng. Khóa API được mã hóa bằng Windows khi hệ thống hỗ trợ; nếu không, khóa chỉ giữ trong phiên làm việc.

## Phím tắt

| Phím | Chức năng |
| --- | --- |
| `Ctrl + N` | Tạo chat mới |
| `Ctrl + ,` | Mở cài đặt |
| `Enter` | Gửi yêu cầu |
| `Shift + Enter` | Xuống dòng |

## Phát triển từ mã nguồn

Yêu cầu Node.js 22.12 trở lên để phát triển và đóng gói desktop.

```powershell
npm install
npm run desktop
```

```powershell
npm test
npm run desktop:pack
```

Bản Setup và Portable được tạo trong thư mục `release`. Cấu hình nhóm agent lưu theo dự án tại `.vibe/config.json`; lịch sử và dữ liệu phiên nằm trong `.vibe`.

## Lưu ý khi sử dụng

- Context và đầu ra vẫn chịu giới hạn thực tế của model/nhà cung cấp. Số token ước tính không thay thế số liệu tính phí của API.
- Phiên lỗi hoặc phiên đang chạy khi đóng app không tự thực thi lại các lệnh ghi tệp khi mở lại.
- Các thay đổi trong worktree cần được kiểm tra và tích hợp vào nhánh dự án.
- Chỉ cấp quyền thực thi lệnh và sửa tệp cho agent trong dự án bạn tin cậy. Lệnh nguy hiểm cần phê duyệt.
- Bản Windows hiện chưa có chữ ký số nhà phát hành.

Giấy phép và thông tin nguồn của các skill được giữ cùng từng gói trong `src/vendor-skills`.

### Kiểm tra dự án cục bộ

- Công cụ `inspect_project` nhận diện Node/Electron, liệt kê dependency, dấu vết SHA-256, install hooks và ứng viên lỗi cấu hình Electron. Không chạy script hoặc cài dependency.
- Ba skill tích hợp tự chọn theo vai: khảo sát dự án, bằng chứng dependency và rà soát Electron. Báo cáo phân biệt quan sát tĩnh với lỗ hổng đã xác minh; giữ UNVERIFIED khi chưa có kiểm tra thực thi.
