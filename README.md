# Screen Layer Cleaner

Figma 화면의 **실제 디자인을 최대한 유지하면서 복잡한 Layer 구조를 자동으로 정리하는 Plugin**입니다.

불필요한 Layer 제거, Instance 해제, 중첩된 Frame / Group 정리, Layer 이름 표준화, Font 변경, Layer 순서 정리 등을 자동으로 수행합니다.

구조 변경이 필요한 작업은 **Depth 단위 Batch 방식**으로 처리하여 속도를 높이고, 렌더링 결과가 달라지는 작업은 해당 Batch만 Rollback하여 원본 화면을 보호합니다.

---

## Overview

기획·디자인 과정에서 반복적으로 수정된 Figma 화면은 불필요하게 복잡한 Layer 구조를 가지는 경우가 많습니다.

```text
Screen
├─ Group
│  └─ Frame
│     └─ Group
│        └─ Text
├─ Instance
│  └─ Frame
│     └─ Text
└─ Rectangle
```

이러한 구조는 다음과 같은 작업에서 불편함을 만들 수 있습니다.

- Layer 탐색 및 관리
- LID 확인 및 키스크린 작업
- 기존 LID 재사용
- Localization 작업
- Figma Plugin을 이용한 Layer 분석
- 불필요한 Group / Frame 식별
- 일관되지 않은 Layer 이름 관리

**Screen Layer Cleaner**는 선택한 Screen을 분석한 뒤, 화면을 유지하면서 불필요한 구조를 정리합니다.

```text
Before

Screen
└─ Group
   └─ Frame
      └─ Group
         ├─ Text
         ├─ Icon
         └─ Rectangle


After

Screen
├─ Text
├─ icon
└─ shape
```

---

## Core Principle

### Visual Preservation

Screen Layer Cleaner의 가장 중요한 원칙은 다음과 같습니다.

> **Layer 구조를 정리하더라도 기존 화면의 시각적 결과는 최대한 유지합니다.**

Plugin은 원본 Screen을 직접 수정하지 않고 **Working Copy에서 Cleanup을 수행**합니다.

```text
Original Screen
      ↓
Working Copy 생성
      ↓
Cleanup
      ↓
Visual Verification
      ↓
PASS → 적용
FAIL → 해당 Batch만 Rollback
```

특정 작업이 화면을 변경한다고 판단되더라도 전체 Cleanup을 취소하지 않습니다.

해당 작업만 되돌리고 다음 Cleanup 단계는 계속 진행합니다.

---

## Features

### 1. Screen Analysis

`Analyze Screen`을 실행하면 선택한 Screen의 Layer 구조를 분석합니다.

다음 항목을 확인할 수 있습니다.

- 전체 Layer 수
- Garbage Candidate
- Container
- Instance
- Auto Layout
- Mask
- Clip
- Text
- Non-Inter Text
- Icon
- Line
- Screenshot Bake Candidate

분석 결과를 기준으로 실제 Cleanup을 수행합니다.

---

### 2. Garbage Detection

불필요할 가능성이 높은 Layer를 자동으로 탐지합니다.

대표적인 Garbage Candidate는 다음과 같습니다.

```text
visible=false
opacity=0
Slice
Zero / Tiny Size
Empty Shape
Empty Container
Outside Screen
```

Garbage Candidate는 바로 삭제하지 않고 목록으로 제공합니다.

사용자는 각 Layer를 확인한 뒤 삭제할 항목만 선택할 수 있습니다.

```text
Garbage Candidates

☑ Rectangle 1234
  Empty Shape
  [보기]

☑ Group 5678
  Empty Container
  [보기]

☐ Rectangle 9999
  Outside Screen
  [보기]
```

`보기` 버튼을 누르면 해당 Layer를 Figma에서 바로 선택하고 확인할 수 있습니다.

---

### 3. Garbage Selective Delete

Garbage Candidate는 Checkbox를 이용하여 삭제 여부를 직접 결정할 수 있습니다.

지원 기능:

- 개별 선택
- 전체 선택
- 전체 해제
- Layer 바로 보기

선택하지 않은 Garbage Candidate는 그대로 유지됩니다.

---

### 4. Root → Frame

선택한 Screen의 최상위 Layer가 Frame이 아닌 경우 가능한 범위에서 Frame으로 변환합니다.

```text
Group
↓
Frame
```

또는

```text
Instance
↓
Detach
↓
Frame
```

대표 Screen의 기존 Layer 이름은 유지됩니다.

```text
Before

차량 구매 - 계약 및 출고(3개월 내)

After

차량 구매 - 계약 및 출고(3개월 내)
```

Root 이름은 자동으로 `frame`으로 변경하지 않습니다.

---

### 5. Instance Detach

Screen 내부 Instance를 탐색하여 가능한 경우 일반 Layer 구조로 변환합니다.

```text
Instance
└─ Component Layers

↓

Frame / Group / Layers
```

Instance는 한 개씩 처리하지 않고 **같은 Depth의 Instance를 Batch 단위로 처리**합니다.

```text
Depth 4

Instance A
Instance B
Instance C
Instance D

↓

Batch Detach

↓

Visual Verification
```

구조가 변경된 이후에는 기존 탐색 결과를 재사용하지 않고 현재 Layer Tree를 다시 분석합니다.

---

### 6. Depth Batch Processing

기존 방식처럼 Layer 하나마다 반복적으로 화면 전체를 검사하지 않습니다.

#### 기존 방식

```text
Layer A
→ 변경
→ 검증

Layer B
→ 변경
→ 검증

Layer C
→ 변경
→ 검증
```

#### 현재 방식

```text
Tree Scan
    ↓
가장 깊은 Layer 탐색
    ↓
같은 Depth 전체 Batch 처리
    ↓
Visual Verification
    ↓
Tree Re-scan
    ↓
다음 Depth 처리
```

이를 통해 구조가 변경된 이후 오래된 Layer 정보를 계속 사용하는 문제를 방지하면서 불필요한 반복 검증도 줄입니다.

---

### 7. Frame / Group Flatten

중첩된 Frame과 Group을 가능한 범위에서 제거합니다.

```text
Before

Frame
└─ Group
   └─ Frame
      ├─ Text
      └─ Icon
```

```text
After

Frame
├─ Text
└─ Icon
```

Flatten 과정에서도 자식 Layer의 실제 위치를 유지하도록 Transform을 다시 계산합니다.

---

### 8. Auto Layout Protection

Auto Layout이나 부모 Layout에 영향을 받는 Layer는 일반 Group처럼 무조건 제거하지 않습니다.

구조 변경으로 화면이 달라질 가능성이 있는 경우 해당 작업을 보호하거나 Rollback합니다.

즉, 단순히 Layer 수를 줄이는 것보다 **현재 화면 유지가 우선**입니다.

---

### 9. Mask / Clip Protection

Mask 또는 실제 Clip이 필요한 Container를 무작정 Flatten하면 화면이 달라질 수 있습니다.

```text
Frame
├─ Mask
└─ Image
```

이러한 영역은 필요한 경우 Screenshot 형태로 변환하여 현재 렌더링 결과를 유지하도록 시도합니다.

```text
Mask / Clip Area
      ↓
PNG Export
      ↓
Image Layer
      ↓
screenshot
```

Screenshot 변환으로 화면이 달라지는 경우 해당 Batch는 Rollback됩니다.

---

### 10. Visual Batch Verification

Instance / Screenshot / Flatten 등 화면 구조에 영향을 줄 수 있는 작업은 Batch 단위로 검증합니다.

```text
Before Render
      ↓
Batch Processing
      ↓
After Render
      ↓
Compare
```

결과가 동일하면 해당 Batch를 유지합니다.

```text
PASS
→ Batch 유지
```

결과가 달라지면 해당 Batch만 되돌립니다.

```text
FAIL
→ 해당 Batch Rollback
→ Layer 보호
→ 다음 단계 계속
```

따라서 일부 Layer를 안전하게 정리할 수 없더라도 전체 Screen Cleanup이 실패하지 않습니다.

---

### 11. Text Layer Name Cleanup

옵션을 활성화하면 일반 Text Layer의 이름을 `-`로 변경합니다.

```text
Before

아이오닉 6 Exclusive(스탠다드)
Vehicle Image
82,120,000원

↓

After

-
-
-
```

실제 화면에 표시되는 Text 내용은 변경되지 않습니다.

변경되는 것은 **Layer Name만**입니다.

---

### 12. LID Protection

Localization에서 사용하는 LID는 Layer 이름 정리 대상에서 제외됩니다.

다음 Prefix를 자동으로 인식합니다.

```text
cci_ctn_
cci_msg_
ctn_
msg_
```

예를 들어 다음 Layer는

```text
cci_ctn_contract_complete_k
```

`Text Layer 이름을 "-"로 변경` 옵션이 활성화되어 있어도 그대로 유지됩니다.

```text
cci_ctn_contract_complete_k
```

따라서 Localization 작업에 필요한 기존 LID가 Cleanup 과정에서 손실되지 않습니다.

---

### 13. Font Family → Inter

옵션을 활성화하면 Screen 내부 Text의 Font Family를 `Inter`로 변경합니다.

```text
Before

Pretendard
Roboto
Arial
SamsungOne
Noto Sans
...

↓

After

Inter
```

기존 Font Style을 분석하여 가능한 Inter Style로 매핑합니다.

```text
Regular   → Inter Regular
Medium    → Inter Medium
SemiBold  → Inter Semi Bold
Bold      → Inter Bold
Italic    → Inter Italic
```

Font 변경은 사용자가 명시적으로 선택한 시각적 변경이므로 일반 구조 Cleanup의 Visual Rollback 대상과 분리하여 처리합니다.

---

### 14. Frame / Group / Auto Layout Naming

옵션을 활성화하면 내부 Container Layer의 이름을 정리합니다.

```text
Frame       → frame
Group       → group
Auto Layout → auto layout
```

iPhone Frame으로 판단되는 경우:

```text
iPhone 15 Pro
↓
iphone
```

옵션을 비활성화하면 기존 Frame / Group / Auto Layout 이름을 유지합니다.

대표 Root Frame 이름은 이 옵션과 관계없이 항상 유지됩니다.

---

### 15. Generic Layer Naming

Layer 유형을 분석하여 일반적인 이름으로 정리합니다.

| Layer | Name |
| --- | --- |
| Icon | `icon` |
| Line | `line` |
| Rectangle / Shape | `shape` |
| Image | `image` |
| Screenshot | `screenshot` |
| Frame | `frame` |
| Group | `group` |
| Auto Layout | `auto layout` |
| Component | `component` |
| Instance | `instance` |
| iPhone Frame | `iphone` |

LID는 Generic Naming보다 항상 우선하여 보호됩니다.

---

### 16. Layer Order Cleanup

최종 Layer 구조는 화면의 시각적 위치를 기준으로 정리합니다.

기본 정렬 기준은 다음과 같습니다.

```text
Top → Bottom
```

같은 행에서는:

```text
Left → Right
```

예를 들어 화면이 다음과 같다면,

```text
A    B
C    D
```

Layer Panel에서도 가능한 범위에서 다음 순서로 정리합니다.

```text
A
B
C
D
```

단, Layer가 서로 겹치는 경우 Layer 순서 자체가 Z-Order에 영향을 줄 수 있으므로 기존 순서를 우선적으로 보존합니다.

LID Layer도 동일한 정렬 기준에 포함됩니다.

---

## Cleanup Pipeline

전체 Cleanup은 다음 순서로 진행됩니다.

```text
Analyze Screen
      ↓
Create Working Copy
      ↓
Garbage Cleanup
      ↓
Root → Frame
      ↓
Instance Depth Batch
      ↓
Mask / Clip Screenshot Batch
      ↓
Frame / Group Flatten Batch
      ↓
Font → Inter
(Optional)
      ↓
Layer Naming
      ↓
Layer Order
      ↓
Commit
```

구조가 변경되는 주요 단계에서는 기존 작업 Plan을 폐기하고 현재 Layer Tree를 다시 탐색합니다.

```text
Structure Change
      ↓
Discard Previous Plan
      ↓
Re-scan Current Tree
      ↓
Continue
```

---

## Performance Architecture

Screen Layer Cleaner는 복잡한 Screen에서 불필요한 반복 작업을 줄이기 위해 **Batch 중심 구조**를 사용합니다.

### Previous

```text
Find Layer
↓
Clone
↓
Render
↓
Change
↓
Render
↓
Compare
↓
Repeat
```

Layer 수가 많아질수록 처리 시간이 크게 증가합니다.

### Current

```text
Tree Scan
↓
Find Same-Depth Tasks
↓
Batch Processing
↓
Single Visual Verification
↓
Re-scan After Structure Change
```

따라서 여러 Instance나 중첩 Container가 존재하는 Screen에서도 개별 Layer마다 전체 화면을 반복 검증하는 작업을 줄일 수 있습니다.

---

## Rollback Strategy

Rollback은 **Batch Rollback**과 **Screen Rollback**으로 구분됩니다.

### Batch Rollback

특정 구조 변경이 화면을 변경하는 경우:

```text
Batch FAIL
↓
Batch Rollback
↓
Problem Area Preserve
↓
Continue Cleanup
```

해당 영역만 보호되며 나머지 Cleanup은 계속 진행됩니다.

따라서 Batch Rollback이 발생하더라도 Screen 자체는 정상적으로 Commit될 수 있습니다.

### Screen Rollback

예상하지 못한 Figma API 오류나 최종 Commit 실패처럼 Cleanup 자체를 계속할 수 없는 경우에만 Screen 전체 작업을 취소합니다.

```text
Fatal Error
↓
Working Copy 제거
↓
Original Screen 유지
```

---

## Result Report

Cleanup이 완료되면 처리 결과를 확인할 수 있습니다.

```text
Cleanup Complete

Visual Verification
PASS

Screen
1

Committed
1

Screen Rolled Back
0

Instance
Detached 12
Rejected 0

Garbage
Deleted 7
Protected 0

Flatten
Container 18
Rejected 2
Moved Layer 34

Screenshot
Baked 1
Rejected 0

Font → Inter
Text 24
Segment 26
Failed 0

Naming
Renamed 31

Layer Order
Changed 1
Rejected 0

Performance
Tree Scan 8
Visual Batch Check 5
Batch Rollback 2
```

화면을 보존하기 위해 거절된 작업이 있는 경우 `Protected / Rejected Batch`에서 원인을 확인할 수 있습니다.

Fatal Error가 발생한 경우에는 별도로 실제 오류 원인이 표시됩니다.

---

## Recommended Workflow

```text
1. 정리할 Screen 선택

2. Analyze Screen 실행

3. Garbage Candidates 확인

4. 삭제할 Garbage 선택

5. 필요한 옵션 선택
   - Font Family → Inter
   - Text Layer → "-"
   - Frame / Group / Auto Layout 이름 정리

6. Clean & Flatten 실행

7. Cleanup Result 확인

8. 최종 Screen 및 Layer 구조 확인
```

---

## Options

### Font Family를 Inter로 변경

Screen 내부 Text의 Font Family를 Inter로 통일합니다.

```text
☑ 모든 Text의 Font Family를 Inter로 변경
```

### Text Layer 이름을 `-`로 변경

일반 Text Layer의 이름을 단순화합니다.

```text
☑ Text Layer 이름을 "-"로 변경
```

LID Layer는 변경 대상에서 제외됩니다.

### Frame / Group / Auto Layout 이름 정리

Container Layer의 이름을 유형에 맞게 정리합니다.

```text
☑ Frame / Group / Auto Layout 이름 정리
```

Root Screen 이름은 변경하지 않습니다.

---

## Safety

Screen Layer Cleaner는 다음 우선순위를 기준으로 동작합니다.

```text
Visual Preservation
        >
Layer Cleanup
        >
Layer Naming
```

즉, Layer를 최대한 많이 제거하는 것보다 **현재 화면을 유지하는 것을 우선합니다.**

안전하게 구조를 변경할 수 없는 영역은 강제로 제거하지 않고 기존 구조를 유지합니다.

---

## Notes

- Cleanup은 원본이 아닌 Working Copy에서 수행됩니다.
- 구조 변경 후에는 현재 Layer Tree를 다시 탐색합니다.
- Instance / Screenshot / Flatten은 Depth Batch 방식으로 처리됩니다.
- 화면이 변경되는 Batch는 자동 Rollback됩니다.
- Rollback된 영역 외의 Cleanup은 계속 진행됩니다.
- LID Layer 이름은 항상 보호됩니다.
- Text 내용 자체는 변경하지 않습니다.
- Root Screen 이름은 항상 유지됩니다.
- Font → Inter는 사용자가 직접 활성화한 경우에만 실행됩니다.
- 복잡한 Mask / Clip / Auto Layout 구조는 화면 보존을 위해 일부 Layer가 그대로 유지될 수 있습니다.

---

## Plugin Structure

```text
Screen Layer Cleaner
├── code.js
├── ui.html
└── manifest.json
```

### `code.js`

다음 기능을 담당합니다.

- Screen / Layer 분석
- Garbage 탐색 및 제거
- Instance Detach
- Mask / Clip 처리
- Frame / Group Flatten
- Font → Inter 변환
- Layer Naming
- Layer Order
- Depth Batch Processing
- Visual Verification
- Batch Rollback
- Final Commit

### `ui.html`

다음 기능을 담당합니다.

- Analyze Screen
- Garbage Candidates 확인
- Garbage 선택 / 해제
- Layer `보기`
- Cleanup 옵션 설정
- Clean & Flatten 실행
- Cleanup 결과 확인
- Protected / Rejected Batch 확인
- Fatal Error 확인

---

## Screen Layer Cleaner

**Clean the structure. Preserve the screen.**
