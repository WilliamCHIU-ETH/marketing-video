#!/usr/bin/env python3
"""驗證 Google service account 是否能讀寫指定的 Sheet 與 Drive 資料夾。

跑法：
    pip3 install google-auth google-api-python-client --break-system-packages -q
    python3 scripts/verify-google.py
"""
import os
import sys

CREDS = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '.google-creds.json')
SHEET_ID = '16FmQVUbgIeL3rHEH3RPsIySKn9cnSkHbIkxNCWmQHrc'
FOLDER_ID = '1yEaaaHPCybzOV80-WAa6fvOlMYLo6eA-'
SCOPES = ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive']

try:
    from google.oauth2 import service_account
    from googleapiclient.discovery import build
    from googleapiclient.http import MediaInMemoryUpload
except ImportError:
    print('[錯誤] 缺少 Python 套件、先跑：')
    print('    pip3 install google-auth google-api-python-client --break-system-packages -q')
    sys.exit(1)

if not os.path.exists(CREDS):
    print(f'[錯誤] 找不到 credentials: {CREDS}')
    sys.exit(1)

creds = service_account.Credentials.from_service_account_file(CREDS, scopes=SCOPES)

print('=== 1. Sheet 讀取測試 ===')
sheets = build('sheets', 'v4', credentials=creds, cache_discovery=False)
meta = sheets.spreadsheets().get(spreadsheetId=SHEET_ID).execute()
print(f"檔名: {meta['properties']['title']}")
for s in meta['sheets']:
    p = s['properties']
    print(f"  分頁: {p['title']} ({p['gridProperties']['rowCount']}列 × {p['gridProperties']['columnCount']}欄)")

print('\n=== 2. Sheet 內容讀取 ===')
for tab in ['影片紀錄', '製作人名單']:
    try:
        r = sheets.spreadsheets().values().get(spreadsheetId=SHEET_ID, range=f"'{tab}'!1:3").execute()
        print(f"{tab} 前 3 列:")
        for row in r.get('values', []):
            print(f"  {row}")
    except Exception as e:
        print(f"  [警告] 讀 {tab} 失敗（分頁名可能拼錯）: {e}")

print('\n=== 3. Drive 資料夾測試 ===')
drive = build('drive', 'v3', credentials=creds, cache_discovery=False)
folder = drive.files().get(fileId=FOLDER_ID, fields='name,mimeType').execute()
print(f"資料夾: {folder['name']} (type: {folder['mimeType']})")
listing = drive.files().list(q=f"'{FOLDER_ID}' in parents and trashed=false", fields='files(id,name)').execute()
print(f"資料夾內現有: {len(listing.get('files', []))} 個檔案")

print('\n=== 4. Drive 寫入測試（建測試檔→立即刪掉） ===')
media = MediaInMemoryUpload(b'hello from service account', mimetype='text/plain')
test = drive.files().create(
    body={'name': '_credentials_test.txt', 'parents': [FOLDER_ID]},
    media_body=media,
    fields='id,name',
).execute()
print(f"建立: {test['name']} (id={test['id']})")
drive.files().delete(fileId=test['id']).execute()
print('刪除: 完成')

print('\n[OK] 全部 4 項通過、credentials 設定完美')
