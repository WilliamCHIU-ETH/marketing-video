# 素材取得失敗政策

Status: `SPEC ONLY — 不改任何現有行為`
Last verified: `2026-08-25 Asia/Taipei`

這份文件回答一個問題：**實機素材取不到的時候，誰該擋下來、誰該接住、fallback 要帶什麼。**

它是 `2026-08-25-arch-gap-recon` P2.5 的產出。第一輪把這件事寫成「fail closed 或自動降級，二選一」，
reviewer 判定那是假兩難（`review-round2.md` R2-01）——兩者可以同時成立，只是分屬不同層。
本文把分層寫定。**實作歸 P5 runner，本文不改任何現有行為。**

---

## 分層

```
                        素材取得失敗時

  ┌─ Material Acquisition Port ─────────────────────────────┐
  │  require-capture → 一律拋 typed failure                  │  ← 不動
  │  絕不回傳 illustrative fallback                          │
  └──────────────────────┬──────────────────────────────────┘
                         │ typed failure（帶 code）
                         ▼
  ┌─ 上層 runner（晨報產線）─────────────────────────────────┐
  │  接住 → 走 illustrative fallback → 保留原始失敗證據       │  ← P5 要實作
  │  繼續做到成片，交付時明說缺口                             │
  └──────────────────────────────────────────────────────────┘
```

**下層 fail closed，上層接住。** 這不是妥協，是兩個不同的責任：
Port 的責任是「絕不讓示意圖冒充 verified asset」；runner 的責任是「不要因為一段素材缺了就交不出片」。

## 規則一：Port 邊界維持 fail closed，不得放寬

`acquireOptionalMaterial()` 在 `policy = require-capture` 下，遇到下列任一情況**一律拋出 typed
failure，不回傳任何替代素材**：

| 類別 | code |
|---|---|
| 未配置／不可用 | `provider_unconfigured` `provider_unavailable` |
| 契約或版本不符 | `provider_contract_incompatible` `provider_version_incompatible` `provider_not_production_ready` `provider_operation_unsupported` `provider_result_incompatible` |
| 就緒性未驗證 | `provider_live_readiness_unverified` |
| 呼叫失敗 | `provider_request_failed` |
| 產物驗證不過 | `provider_artifact_*` `provider_evidence_invalid` `provider_media_*` `provider_mime_mismatch` `provider_output_invalid` `provider_provenance_invalid` |
| provider 未完成 | result status 為 `human_action_required` / `rejected` / `failed` |

**明確禁止**：不得把 `acquireOptionalMaterial(require-capture)` 改成回傳 illustrative fallback。
那會放寬 prepared-video 的 no-silent-fallback 契約，等於拆掉保護清單的執行機制。

`policy = prefer-capture` 的既有 fallback 行為不變——它本來就宣告了會降級。

## 規則二：上層 runner 接住，並且必須帶齊四個欄位

晨報 runner 接到上述 typed failure 時，改走 illustrative branch 繼續產片。
fallback 產物**必須**攜帶：

```
degraded          true
failureCode       原始的 typed code，不得改寫成泛化字串
provider          providerId（取不到就 null，不得省略欄位）
failedAt          ISO-8601 時間
```

並且畫面上必須明示為示意（現行做法是右上角標「示意畫面，非實機」），交付摘要必須列出這個缺口。

這正是 `SKILL.md` 硬約束 6 已經對 agent 產線寫明的行為——**App 產線只是還沒有對應的上層**，
本文把它寫成兩條產線共用的一句話。

## 規則三：錯誤訊息不得比 code 更泛化

2026-08-25 實測到的觀測性缺陷（wK 回報）：`job.json` 的
`materialAcquisitionResult.reason` 是 `provider_version_incompatible`，
但表面 error 印的是泛化的 "provider unavailable"。這讓指揮官誤判 smoke 紅的根因。

**規則**：任何往上傳遞的錯誤訊息，其具體程度不得低於它攜帶的 code。
Port 在 `capabilities` 的 catch 保留了 code 卻覆蓋訊息，屬於違反本條。

## 一句話版本

> **Port 遇到任何素材問題一律 fail closed 拋 typed code；晨報 runner 接住它、改用明示的示意素材、
> 保留原始失敗證據、繼續做到成片，並在交付時列為缺口。示意素材永遠不得冒充 verified asset。**

這句話對兩條產線都成立，且不與保護清單任一項衝突。

## 不在本文範圍

- runner 的實作（歸 P5）
- `prefer-capture` 的既有降級路徑（未變更）
- provider 端要怎麼避免失敗（那是 provider repo 的事）
