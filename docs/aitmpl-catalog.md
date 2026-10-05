# Thư viện AITMPL trong Vibe Studio

Snapshot nguồn công khai: [davila7/claude-code-templates](https://github.com/davila7/claude-code-templates), commit `ef41915c4b69c2b8e2dfa37ae65977e438f853d0`, website [aitmpl.com](https://aitmpl.com/).

Catalog gồm 2.043 thành phần: 914 skill, 424 agent, 348 command, 105 MCP, 72 setting, 63 hook, 18 loop, 39 mod, 12 sandbox, 14 template và 34 mục plugin. Có 7.149 tệp tài nguyên từ `cli-tool/components`, `cli-tool/templates`, giấy phép và registry nguồn. Các file chưa được phản ánh trong index của website cũng được nhập. Plugin liên kết đến repository ngoài được lưu dưới dạng metadata/manifest của website, không phải mã nguồn của mọi repository bên ngoài. Snapshot không bao gồm tài khoản, dịch vụ trả phí, blog/job hay dữ liệu riêng của website.

## Dùng trong app

Mở **Tích hợp dự án → Thư viện AITMPL**, tìm theo nội dung hoặc chọn loại. Catalog có phân trang; phần xem chi tiết cho phép chọn tài nguyên và đọc tiếp. Nội dung hiển thị bằng text, không chạy HTML/script từ template.

- Skill, command và loop có thể gán như hướng dẫn cho từng vai. Command/loop là prompt hướng dẫn, không phải shell tự thực thi hay bộ lập lịch mới. Không thay cơ chế chống vòng lặp của Teamwork.
- Agent được thêm như cấu hình named agent, có vai được chọn và skill gốc. Model dùng mặc định hiện có; có thể chỉnh trong Thiết lập team. Không tự đổi sang model được nhắc trong frontmatter của nguồn.
- MCP được chuyển thành cấu hình native của Vibe, giữ nguyên server hiện có. Mẫu được nhập ở trạng thái tắt; điền token/đường dẫn trong mục MCP, bật rồi kiểm tra kết nối. Nguồn có thể yêu cầu npm, uv, Docker, browser hoặc dịch vụ riêng. Nhập preset không chứng minh server đã kết nối hay đã cài runtime.
- Setting, hook, mod, sandbox, template và plugin được xuất vào `.vibe/templates/<id-hash>` cùng nguồn và giấy phép. Cấu hình dành cho engine Claude không được tự cài vào engine Vibe. App ghi trạng thái `reference`, `compatible:false`; cần chuyển đổi cụ thể trước khi thực thi.

Agent có `search_templates`, `read_template`, `search_skills`, `load_skill`, `read_skill_resource`. ID đầy đủ có dạng `aitmpl:skills/creative-design/frontend-design`. Toàn bộ catalog không được chèn vào prompt. Khi bật tự tích hợp và auto-skill, app chọn tối đa một skill AITMPL có điểm phù hợp cao với chuyên môn của vai; hướng dẫn vẫn nằm trong ngân sách skill hiện có. Có thể tắt **Tự thiết lập** hoặc auto-skill của từng vai để chỉ dùng lựa chọn thủ công.

Quyền đọc/ghi/chạy lệnh, scope tệp và tiêu chí nghiệm thu của Vibe không thay đổi theo template. Source hash chỉ xác minh snapshot không bị thay đổi, không phải chứng nhận an toàn hoặc chất lượng của cộng đồng. Script hỗ trợ cần runtime tương ứng; có thể đọc tài nguyên qua công cụ thay vì giả định script đã được chạy.

## Đóng gói và cập nhật

`src/template-assets` chứa index, thông tin snapshot, giấy phép và 64 archive gzip có checksum. App kiểm tra hash index, archive và từng tài nguyên. Tài nguyên được đọc khi cần và có giới hạn dòng/kích thước; snapshot dùng offline được cả trong CLI và EXE.

Để nhập snapshot mới, clone nguồn vào `.vibe/upstream-aitmpl`, chạy `node scripts/import-aitmpl.mjs`, xem thay đổi và chạy kiểm thử/build. Generator không chạy installer của bên thứ ba. Thông tin nguồn/commit và các giấy phép trong resource được giữ nguyên; giấy phép MIT của collection không thay thế giấy phép riêng của tác giả.

Kiểm thử bao phủ tìm kiếm/phân trang, nguyên vẹn tài nguyên, chặn đường dẫn ngoài bundle, nạp skill vào request model thực tế, giữ model/config, nhập MCP tắt, xuất hook không thực thi, và thao tác tìm/xem/gán skill trên Electron.
