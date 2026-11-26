# 釣り情報ダッシュボード（tsuri-dash）改造ガイド

公開URL: https://chillwo.github.io/tsuri-dash/ （GitHub Pages、main ブランチのルートをそのまま配信）

## 構成
サーバー不要の静的Webアプリ。ブラウザが Open-Meteo の公開API（天気・海洋・潮位モデル・地名検索）を直接呼び、地点・釣果記録は各端末の localStorage に保存する。

```
src/index.html   画面の骨組み（/*CSS*/ と /*JS*/ の位置に build.py が中身を埋め込む）
src/style.css    見た目。light-dark() で書いてよい（build.py が古いブラウザ向けに変換する）
src/astro.js     月齢・潮名・月の出入り・日の出入りの計算。TZ_OFF_MIN（地点のUTCオフセット）を使う
src/backend.js   データ取得（Open-Meteo / MET Norway）、潮位の20分補間と満干潮抽出、端末内保存、バックアップ
src/app.js       画面描画とイベント（8ブロック：ヘッダー/現在/タイド/風/時間別/週間/釣果情報/自分の記録）
build.py         src/ を1ファイルの index.html と manifest.webmanifest にまとめる
index.html ほか  公開されるファイル（build.py の出力。直接編集しない）
icon-*.png       アイコン
```

## 改造の手順
1. `src/` のファイルを編集する（`index.html` を直接編集しない）。
2. `python3 build.py` で `index.html` を作り直す。
3. 確認：`python3 -m http.server` で配信し、スマホ幅（390px）で表示・操作を確認する。外部APIに接続できない環境では Open-Meteo の応答をモックする。
4. コミットして main に push すると、1〜2分で公開URLに反映される。

## 守ること
- 利用者のデータ（localStorage のキー `fd.v1`、`fd.cond.<地点ID>`）の形式を変えるときは、古い形式を読めるようにする（友人の端末に既存データがある）。
- 外部から読み込めるのは Open-Meteo・MET Norway・Google Fonts のみの想定。APIキーが必要なサービスは使わない（公開ページにキーが露出するため）。
- 個人情報（名前・連絡先・自宅位置など）をコードに入れない。リポジトリは公開。
- 単位：風速 m/s、潮位 cm（平均海面基準）、風向は16方位＋矢印。
- Open-Meteo の無料版は非商用利用が前提。
