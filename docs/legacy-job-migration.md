# Legacy Jobs migration

這個工具把舊 `jobs/` 的可驗證內容轉成 `Project → Revision → Run`。它預設只做 dry-run；不會修改來源，也不會自動對正式 runtime 執行。

決策與驗收邊界見 GitHub ADR Issue #12。

## Source 與 target

`--source` 必須指向 legacy runtime root，底下要有 `jobs/<job-id>/job.json`。Job 引用的 archive 也必須位於這個 source root；工具拒絕 symlink、path escape、缺檔、size 不符與無法辨識的素材。

`--data-dir` 是新的 runtime root。第一次 apply 要使用空白 target；若只存在部分預期 Project／Run，工具會 fail closed，不會補寫或覆寫。

## Commands

先預覽並完整 preflight：

```bash
npm run migrate:legacy -- --source /path/to/legacy-runtime --data-dir /path/to/new-runtime
```

確認 JSON grouping 後才 apply：

```bash
npm run migrate:legacy -- --source /path/to/legacy-runtime --data-dir /path/to/new-runtime --apply
```

獨立驗證既有結果：

```bash
npm run migrate:legacy -- --source /path/to/legacy-runtime --data-dir /path/to/new-runtime --verify
```

## Safety contract

- 相同 template 加上相同的非空 title，或相同 paid speaker master SHA-256，才會合併成同一 Project；空 title 各自獨立。
- 素材在 Project 內依 role 加 SHA-256 去重，共用於多個 Revision。
- output 必須通過 containment、size 與 SHA-256；成品只保存於 Project outputs。
- legacy Run 只建立目前 UI 所需的 `job.json`／`log.txt`，不複製大型 input/state/out payload。
- 非終態 legacy Job 不能跨版本安全續跑，會標成 `failed`，但其可辨識素材與 metadata 仍保留。
- 所有檔案先寫入同 filesystem staging，完整驗證後才 promotion；失敗會回收本輪新建 target。
- 相同 migration 重跑只做 verify，不重複 Project、Revision、Asset 或 output。

測試使用 synthetic fixtures：

```bash
npm run test:legacy-migration
```

對真實資料執行 `--apply` 是另一個操作決策，必須先備份並取得明確授權。
