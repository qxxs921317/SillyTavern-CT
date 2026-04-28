# Peek 👀

캐릭터 카드를 한국어로 번역해서 보여주는 SillyTavern 확장. 실제 카드 데이터는 안 건드리고, 카드 아래에 번역 결과만 띄워줘.

## 특징

- 🔒 **카드 안 건드림** — description, first_mes 등 원본 그대로. RP에 영향 0
- 🔌 **연결 프로필 사용** — 메인 API랑 별도로, 번역 전용 모델(예: 빠르고 싼 거) 따로 지정
- 💾 **저장됨** — 번역 결과가 캐릭터별로 저장되어 새로고침해도 안 날아감
- 📂 **필드 선택** — description / personality / scenario / first_mes / mes_example / creator notes 중 원하는 것만
- 🎨 **카드 아래 표시** — 캐릭터 편집 패널 바로 아래 접이식 영역

## 설치

SillyTavern → Extensions → Install Extension → 이 GitHub 레포 URL 붙여넣기.

## 사용법

1. **연결 프로필 만들기** (없으면): SillyTavern의 Connection Manager에서 번역용 API 프로필 생성. Gemini Flash나 Claude Haiku처럼 빠르고 싼 모델 추천.
2. **확장 패널 열기**: Extensions 탭 → Peek 👀 펼치기.
3. **프로필 선택** → **번역할 필드 체크** → **번역하기** 클릭.
4. 확인창 뜨면 OK. 잠시 후 캐릭터 카드 아래에 번역 결과가 뜸.

## 동작 원리

- `ConnectionManagerRequestService.sendRequest`로 선택된 프로필에 직접 요청 → 메인 채팅 컨텍스트, lorebook, 시스템 프롬프트 등 일절 안 섞임
- 결과는 `extension_settings.peek.translations[avatar파일명]`에 저장
- 캐릭터 전환 시 자동으로 해당 캐릭터의 저장된 번역 불러옴

## 라이선스

MIT
