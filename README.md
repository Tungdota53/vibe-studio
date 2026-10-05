# Vibe Studio 1.0

**AI workspace trên Windows dành cho lập trình, quản lý dự án và phối hợp nhiều agent.**

Vibe Studio đưa chat AI, chỉnh sửa mã nguồn, quản lý context, kiểm thử, Git, MCP và điều phối multi-agent vào cùng một ứng dụng desktop.

> Làm việc với cả dự án — không chỉ với một ô chat.

[**Tải Vibe Studio 1.0**](https://github.com/Tungdota53/cutty-studio/releases/tag/v1.0.0) · [**Mã nguồn**](https://github.com/Tungdota53/cutty-studio)

![Vibe Studio Agent Map](docs/agent-map-preview.png)

---

## ✨ Tổng quan

Vibe Studio được thiết kế cho các workflow phát triển phần mềm có AI tham gia trực tiếp vào dự án.

Bạn có thể:

- Mở một thư mục dự án và trò chuyện trực tiếp với codebase.
- Cho AI đọc, tìm kiếm và chỉnh sửa tệp.
- Chạy lệnh, test và kiểm tra Git diff.
- Phân công nhiều agent làm việc song song.
- Theo dõi toàn bộ tiến trình bằng sơ đồ trực quan.
- Khôi phục phiên làm việc từ checkpoint.
- Kết nối nhiều model và nhiều MCP server.
- Quản lý context, token, ngân sách và quyền thực thi.
- Xem preview web ngay cạnh cửa sổ chat.

---

# 💬 Chat với dự án

Không cần copy từng đoạn code vào chatbot.

Chọn thư mục dự án, tạo phiên làm việc và để Vibe Studio sử dụng trực tiếp các tệp liên quan trong workspace.

### Hỗ trợ

- Tạo chat mới và mở lại lịch sử đã lưu.
- Streaming phản hồi trực tiếp.
- Dừng tác vụ ngay khi agent đang chạy.
- Theo dõi tool call, bước đã hoàn tất và lỗi ngay trong chat.
- Đọc, tìm kiếm và chỉnh sửa tệp.
- Xem Git diff.
- Chạy shell command và test theo quyền của agent.
- Sao chép toàn bộ câu trả lời hoặc từng code block.
- Markdown với heading, bảng, danh sách và syntax highlighting.

### Chế độ làm việc

Mỗi phiên có thể chạy theo một trong các chế độ:

- **Hỏi**
- **Lập kế hoạch**
- **Triển khai**
- **Kiểm chứng**
- **Chẩn đoán / sửa lỗi**

Runtime tự giới hạn quyền của agent dựa trên chế độ hiện tại.

---

# 🤝 Teamwork — Multi-agent thực sự

Teamwork cho phép chia một yêu cầu lớn thành nhiều tác vụ và giao cho nhiều agent xử lý đồng thời.

Agent có thể đảm nhiệm các vai trò như:

- Planner
- Coder
- Tester
- Reviewer
- Researcher
- Validator

Số agent hoạt động đồng thời có thể cấu hình từ **1 đến 16**.

Mỗi task có:

- người phụ trách;
- phạm vi tệp;
- dependency;
- tiêu chí nghiệm thu;
- trạng thái thực thi;
- kết quả và bằng chứng kiểm tra.

Các nhánh độc lập vẫn tiếp tục chạy ngay cả khi một nhánh khác thất bại.

Nếu task đang chờ đầu ra của task khác, Vibe Studio hiển thị rõ nguyên nhân thay vì để agent chạy vô ích.

---

## ♻️ Phục hồi Teamwork

Một phiên bị gián đoạn không nhất thiết phải bắt đầu lại từ đầu.

Trong phiên Teamwork cũ, chỉ cần nhập:

```text
tiếp tục
```

Vibe Studio sẽ cố gắng khôi phục:

- kế hoạch;
- checkpoint;
- task đã hoàn tất;
- kết quả hợp lệ;
- trạng thái chiến lược phục hồi.

Planner không tự tạo lại kế hoạch mới nếu kế hoạch cũ vẫn hợp lệ.

Nếu nguồn đã thay đổi hoặc chưa chọn đúng phiên, ứng dụng sẽ giải thích nguyên nhân thay vì tiếp tục trên trạng thái không an toàn.

---

# 🧠 Phục hồi thích ứng

Khi một hướng sửa thất bại, Vibe Studio không chỉ lặp lại cùng một phương án.

Pipeline có thể chuyển chiến lược theo chuỗi:

```text
Sửa trực tiếp
      ↓
Chẩn đoán nguyên nhân
      ↓
Tái hiện tối thiểu
      ↓
Triển khai phương án thay thế
```

Các cách sửa đã thất bại được lưu lại để agent tránh lặp lại cùng một chiến lược.

Nếu mã nguồn vẫn tiếp tục có tiến triển, pipeline có thể tiếp tục sửa và kiểm tra thay vì dừng ở một số vòng retry cố định.

Chỉ yêu cầu người dùng can thiệp khi:

- các hướng xử lý được phép đều thất bại;
- thiếu bằng chứng cần thiết;
- thiếu quyền;
- có xung đột nguồn;
- hoặc trạng thái thao tác ghi không thể xác định an toàn.

---

# 🛰 Trung tâm điều hành phiên

Operations Center giúp theo dõi toàn bộ vòng đời của một phiên Teamwork.

Bạn có thể:

- bổ sung yêu cầu khi Teamwork vẫn đang chạy;
- ưu tiên task chưa bắt đầu;
- tạm dừng giao task mới;
- xem lỗi gốc và các lần tự phục hồi;
- xem task đang chờ dependency;
- kiểm tra validation thất bại;
- xem timeline agent, model, lệnh và kết quả;
- xem diff tại từng checkpoint;
- xuất hồ sơ bàn giao dạng Markdown hoặc JSON.

Xem thêm:

[**Quy trình và giới hạn của Trung tâm điều hành**](docs/operations-center.md)

---

# 🗺 Agent Map trực tiếp

Vibe Studio cung cấp sơ đồ trực quan để theo dõi nhóm agent theo thời gian thực.

Bạn có thể xem:

- agent nào đang hoạt động;
- model đang được gọi;
- nhiệm vụ đang xử lý;
- bước hiện tại;
- dependency giữa các task;
- trạng thái chạy / chờ / hoàn tất / lỗi;
- thời điểm có tiến độ thực tế gần nhất.

Có thể chuyển giữa:

- **Danh sách agent**
- **Đồ thị dependency**

Bấm vào một task để xem:

- skill;
- phạm vi tệp;
- kết quả;
- lịch sử hoạt động;
- bằng chứng kiểm tra.

Sơ đồ hỗ trợ:

- zoom;
- thu nhỏ;
- fit-to-screen;
- theo dõi task đang chạy;
- dark UI;
- chế độ giảm chuyển động theo thiết lập hệ điều hành.

---

## Heartbeat ≠ tiến độ

Vibe Studio phân biệt rõ:

- agent vẫn còn sống;
- agent thực sự tạo ra kết quả mới.

Nếu không có tiến độ thực tế trong **90 giây**, giao diện sẽ hiển thị cảnh báo.

Một số thao tác cũng có giới hạn an toàn:

| Tác vụ | Giới hạn |
|---|---:|
| Shell command | 2 phút |
| Test suite | 5 phút |
| Git operation | 30 giây |

Khi timeout, cây tiến trình do Vibe Studio tạo sẽ được dừng và checkpoint vẫn được giữ lại để kiểm tra trước khi thử tiếp.

---

# 🧪 Kiểm thử và nghiệm thu

Vibe Studio tách biệt:

- kiểm tra runtime;
- kiểm tra import;
- lệnh test bắt buộc;
- thao tác lưu báo cáo;
- kiểm chứng nguồn cuối.

Một số nguyên tắc:

- Kết quả của lần chạy mới nhất của cùng một lệnh được ưu tiên.
- Lịch sử lỗi cũ vẫn được giữ để tra cứu.
- Search không có kết quả không tự bị coi là test fail.
- Runtime tùy chọn không tồn tại không tự chặn nghiệm thu.
- Test bắt buộc thất bại vẫn chặn.
- Timeout vẫn chặn.
- Dependency audit phát hiện lỗ hổng chưa xử lý vẫn chặn.
- Reviewer và tester phải kiểm tra trên nguồn cuối cùng.

Node Playwright không yêu cầu Python.

Tester/reviewer có thể sử dụng:

```text
write_report
```

để lưu báo cáo JSON trong:

```text
test-results/
reports/
```

mà không cần quyền chỉnh sửa mã nguồn.

---

# 🔐 Kiểm soát thay đổi và checkpoint

Vibe Studio lưu checkpoint trước và sau các thao tác chỉnh sửa.

Bạn có thể:

- xem diff;
- chọn tệp để hoàn tác;
- so sánh với thay đổi mới của người dùng;
- kiểm tra xung đột trước khi restore.

Snapshot của command được giới hạn phạm vi và dung lượng. Nếu dữ liệu bị cắt bớt, giao diện sẽ hiển thị rõ phần không được lưu.

Với tác vụ ghi:

- worker phải kiểm tra nguồn trước khi ghi;
- file lock được giữ theo task;
- thay đổi ngoài phiên có thể bị chặn;
- các tên tệp Windows mơ hồ bị từ chối.

---

# 🌳 Git Worktree cách ly

Với repository Git sạch, Vibe Studio có thể tạo worktree riêng cho agent.

Điều này giúp:

- giảm ảnh hưởng lên workspace chính;
- cô lập thay đổi;
- kiểm tra trước khi tích hợp.

Chỉ các tệp đã được nghiệm thu **PASS** mới được đưa vào bước tích hợp.

Trước khi merge lại workspace chính, Vibe Studio kiểm tra:

- xung đột với thay đổi của người dùng;
- trạng thái nguồn;
- checkpoint cần thiết để hoàn tác.

---

# 🧩 Agent & Skill

Mỗi agent có thể được cấu hình riêng:

- model;
- system instruction;
- vai trò;
- skill;
- trạng thái bật / tắt.

Vibe Studio hiện đi kèm:

**7 skill vai trò**  
**38 gói skill bổ sung**

bao phủ các nhóm:

- lập trình;
- UI/UX;
- bảo mật;
- kiểm thử;
- nghiên cứu;
- điều phối tác vụ.

Skill có thể được:

- đề xuất tự động theo vai trò và chủ đề;
- chọn thủ công;
- kiểm tra nguồn;
- kiểm tra license;
- xác minh integrity trước khi nạp.

Thông tin skill trong **Công cụ phiên** bao gồm:

- nguồn;
- commit;
- license;
- integrity;
- runtime yêu cầu.

---

# 🔌 Multi-MCP

Vibe Studio hỗ trợ nhiều MCP server trong cùng một dự án.

Các kiểu kết nối:

- **Streamable HTTP**
- **Stdio chạy cục bộ**

Mỗi server có trạng thái và namespace riêng để tránh xung đột tên tool.

Bạn có thể:

- thêm nhiều server;
- bật / tắt từng server;
- xóa cấu hình;
- xem số tool kết nối thành công;
- tra cứu tool trong Công cụ phiên.

Các agent song song có thể sử dụng nhiều MCP server cùng lúc.

Lỗi của một server không làm mất trạng thái của các server còn lại.

---

## Tích hợp dự án tự động

Mục **Tích hợp dự án** có thể nhận diện công nghệ thông qua manifest và đề xuất skill/MCP trước khi agent bắt đầu.

Ví dụ:

```text
Web project       → Playwright MCP
Library / SDK     → Context7
```

Playwright được cài riêng tại:

```text
.vibe/integrations
```

với:

- phiên bản npm được cố định;
- install script bị vô hiệu hóa;
- trạng thái runtime được kiểm tra rõ ràng.

Nếu thiếu API key, runtime hoặc kết nối mạng, ứng dụng báo riêng từng nguyên nhân nhưng vẫn cho agent tiếp tục sử dụng những công cụ còn khả dụng.

---

# 📚 Context Engine

Vibe Studio quản lý context theo khả năng thực tế của model.

Chế độ **Auto** sử dụng context window mà provider công bố.

Nếu API không cung cấp metadata, Vibe Studio sử dụng cấu hình dự phòng.

Context fallback mặc định:

**1.000.000 token**

Các cấu hình Auto cũ được tự nâng lên giá trị mới.

Nếu provider công bố giới hạn thực tế, giá trị đó được ưu tiên.

Cấu hình thủ công của người dùng luôn được giữ.

---

## Theo dõi context

Bảng context phân biệt:

- context window hiệu lực;
- ngân sách input;
- vùng dành cho output;
- token đầu vào;
- token đầu ra;
- số lần nén.

Bạn cũng có thể nén context thủ công.

Khi context cần thu gọn, Vibe Studio nén lịch sử cũ nhưng vẫn giữ:

- yêu cầu quan trọng;
- memory;
- metadata cần thiết;
- khả năng truy xuất lại log gốc của task.

---

# 🧷 Session Memory

Trong **Công cụ phiên**, bạn có thể:

- ghim yêu cầu;
- thêm source file vào context;
- xem nguồn của context;
- xem nhóm lượt;
- xem lượng token ước tính.

Memory có thể được gắn với hash của tệp nguồn.

Nếu nguồn thay đổi, memory không còn hợp lệ sẽ tự bị loại khỏi context.

Những cách sửa đã được nghiệm thu có thể được lưu lại cùng bằng chứng kiểm tra để tái sử dụng chính xác hơn trong các vòng tiếp theo.

---

# 💰 Token, thời gian và ngân sách

Có thể đặt ngân sách riêng cho:

- agent;
- task.

Các chỉ số gồm:

- token;
- USD;
- thời gian;
- số lượt model;
- số lượt tool.

Ứng dụng cảnh báo khi đạt khoảng **80% ngân sách**.

Chi phí được tính theo bảng giá bạn nhập.

Nếu chưa cấu hình giá, giao diện hiển thị rõ rằng chi phí chưa thể tính.

Đặt:

```text
Reasoning budget = 0
Tool budget      = 0
```

để bỏ giới hạn số lượt.

Nút **Dừng** và cơ chế phát hiện vòng lặp không tiến triển vẫn luôn hoạt động.

---

# 🌐 Web Preview cạnh chat

Vibe Studio có thể mở trực tiếp tệp HTML trong workspace trên panel preview riêng.

Hỗ trợ:

- HTML;
- CSS;
- JavaScript;
- tự reload khi source thay đổi;
- reload thủ công;
- JavaScript console;
- runtime error;
- rejected Promise.

Có thể kiểm tra layout ở chiều rộng:

```text
320px
```

và phát hiện một số vấn đề như:

- overflow ngang;
- ảnh lỗi;
- phần tử thiếu nhãn.

Bản EXE cũng hỗ trợ chụp vùng preview.

> Preview hiện tập trung vào dự án web tĩnh. Ứng dụng yêu cầu dev server cần build thành HTML trước khi preview.

Preview chạy trong iframe cô lập, không có quyền truy cập backend và chặn các tệp nội bộ hoặc nhạy cảm.

---

# 🔍 Kiểm tra dự án cục bộ

Tool:

```text
inspect_project
```

có thể khảo sát project mà **không chạy script và không tự cài dependency**.

Nó có thể nhận diện:

- Node;
- Electron;
- dependency;
- dấu vết SHA-256;
- install hook;
- ứng viên lỗi cấu hình Electron.

Ba skill tích hợp có thể tự chọn theo vai:

- khảo sát dự án;
- bằng chứng dependency;
- rà soát Electron.

Báo cáo luôn phân biệt giữa:

```text
Static observation
```

và:

```text
Verified vulnerability
```

Nếu chưa có kiểm chứng thực thi, kết quả được giữ ở trạng thái:

```text
UNVERIFIED
```

---

# 🔄 Khôi phục khi stream bị ngắt

Nếu kết nối model bị gián đoạn, Vibe Studio có thể tiếp tục trên **cùng model** với tối đa hai lần phục hồi.

Hệ thống giữ:

- checkpoint;
- kết quả tool đã hoàn thành;
- trạng thái task hợp lệ.

Các tool call chưa hoàn chỉnh sẽ bị loại bỏ để tránh ghi hoặc chạy lại thao tác có kết quả không xác định.

---

# ⚙️ Kết nối model

Vibe Studio hỗ trợ các API tương thích OpenAI.

Bạn chỉ cần cấu hình:

```text
API URL
API Key
Model Name
```

Điều này cho phép sử dụng nhiều provider và model khác nhau mà không khóa ứng dụng vào một dịch vụ duy nhất.

---

# 📦 Tải Vibe Studio

Mở:

[**Vibe Studio 1.0 Releases**](https://github.com/Tungdota53/cutty-studio/releases/tag/v1.0.0)

Chọn bản dành cho **Windows x64**.

| Tệp | Mục đích |
|---|---|
| `Vibe-Studio-1.0.0-x64-Setup.exe` | Cài ứng dụng và tạo shortcut |
| `Vibe-Studio-1.0.0-x64-Portable.exe` | Chạy trực tiếp, không cần cài đặt |
| `SHA256SUMS-1.0.0.txt` | Kiểm tra checksum tệp tải xuống |

---

# 🚀 Bắt đầu

### 1. Mở dự án

Khởi động Vibe Studio và chọn thư mục dự án.

### 2. Kết nối model

Vào **Cài đặt** và nhập:

- API URL;
- API key;
- tên model.

### 3. Thiết lập context

Chọn:

- **Auto**

hoặc nhập giới hạn context thực tế của model.

### 4. Bắt đầu làm việc

Bạn có thể:

- chat trực tiếp với dự án;

hoặc:

- mở **Teamwork** để giao việc cho nhiều agent.

### 5. Tùy chỉnh agent

Mở **Thiết lập agent** để cấu hình:

- model;
- skill;
- vai trò;
- số agent chạy đồng thời.

---

# ⌨️ Phím tắt

| Phím | Chức năng |
|---|---|
| `Ctrl + N` | Chat mới |
| `Ctrl + ,` | Mở Cài đặt |
| `Enter` | Gửi yêu cầu |
| `Shift + Enter` | Xuống dòng |

---

# 🛠 Phát triển từ source

Yêu cầu:

```text
Node.js >= 22.12
```

Cài dependency:

```powershell
npm install
```

Chạy desktop app:

```powershell
npm run desktop
```

Chạy test:

```powershell
npm test
```

Đóng gói:

```powershell
npm run desktop:pack
```

Các bản build được tạo trong:

```text
release/
```

---

# 📁 Dữ liệu dự án

Cấu hình agent được lưu theo từng project:

```text
.vibe/config.json
```

Lịch sử chat, session và dữ liệu runtime nằm trong:

```text
.vibe/
```

---

# 💻 Runtime

Ứng dụng desktop đã đóng gói runtime cần thiết để khởi động, vì vậy bạn **không cần cài Node.js chỉ để mở Vibe Studio**.

Tuy nhiên, project của bạn vẫn cần các runtime hoặc công cụ mà chính project sử dụng, ví dụ:

- Git;
- npm;
- Node.js;
- Python;
- browser cho Playwright.

---

# 🔑 Bảo vệ API Key

API key được mã hóa bằng cơ chế bảo vệ của Windows khi hệ thống hỗ trợ.

Nếu môi trường không hỗ trợ cơ chế lưu an toàn, key chỉ được giữ trong phiên hiện tại thay vì ghi xuống đĩa theo cách không an toàn.

---

# ⚠️ Lưu ý

- Context và output vẫn chịu giới hạn thực tế của model/provider.
- Token hiển thị trong ứng dụng là số liệu ước tính và không thay thế billing chính thức từ API provider.
- Phiên bị lỗi hoặc đang chạy khi đóng ứng dụng sẽ không tự chạy lại thao tác ghi khi mở lại.
- Thay đổi trong Git worktree cần được kiểm tra trước khi tích hợp vào nhánh chính.
- Chỉ cấp quyền chạy lệnh và sửa tệp cho agent khi bạn tin cậy project.
- Lệnh nguy hiểm yêu cầu phê duyệt.
- Bản Windows hiện tại **chưa có chữ ký số nhà phát hành**.

---

# 📜 Skill provenance

Thông tin giấy phép và nguồn của các skill đi kèm được lưu cùng từng package tại:

```text
src/vendor-skills
```

Vibe Studio không coi các nguồn bên ngoài là đã được chứng nhận chỉ vì chúng có thể được tải về.

Các package tích hợp được kiểm tra theo:

- nguồn;
- commit;
- checksum;
- license;
- runtime yêu cầu.

---

## Vibe Studio 1.0

**Chat với codebase.  
Điều phối nhiều agent.  
Theo dõi mọi thay đổi.  
Kiểm chứng trước khi hoàn tất.**

[**Tải Vibe Studio 1.0 →**](https://github.com/Tungdota53/cutty-studio/releases/tag/v1.0.0)

[**Xem source code →**](https://github.com/Tungdota53/cutty-studio)
