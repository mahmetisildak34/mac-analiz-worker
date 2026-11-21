# UEFA arşivinde 12:00 UTC

Ön yüzün `loadUefaFeed` işlevi FixtureDownload `DateUtc` alanını hem tarih/saat hem gün olarak okur. Sonraki `addMatch` çağrısı özgün tarih/saati kullanmak yerine `row.date+"T12:00:00Z"` oluşturur. Canlı arşivdeki `raw_json.fixture.date` alanı bu oluşturulmuş değeri tekrarlar. Arşivdeki JSON, FixtureDownload kaydının özgün kopyası değildir. [İçe aktarıcı, salt okunur inceleme](https://github.com/mahmetisildak34/mac-analiz-merkezi/blob/2927ca772f9d521305daca0f5c6c3efc637a8e2a/index.html#L5794-L5831)

| Maç | Aşama | FixtureDownload no | UEFA maç kimliği | Özgün UTC | Arşiv UTC |
| --- | --- | ---: | ---: | --- | --- |
| Feyenoord 0–4 Leverkusen | 2024/25 Şampiyonlar Ligi, lig aşaması 1 | 14 | 2042028 | 19 Eylül 2024 16:45 | 19 Eylül 2024 12:00 |
| Girona 2–3 Feyenoord | 2024/25 Şampiyonlar Ligi, lig aşaması 2 | 29 | 2041951 | 2 Ekim 2024 16:45 | 2 Ekim 2024 12:00 |

Özgün FixtureDownload zamanında `Z` UTC’yi belirtir. Rotterdam ve Girona’da bu tarihlerde geçerli yerel UTC+2 ile 16:45 UTC, 18:45 yerel saate karşılık gelir. Arşivdeki 12:00, içe aktarıcıdaki sabit değerdir. [FixtureDownload özgün sezon verisi](https://fixturedownload.com/feed/json/champions-league-2024) · [UEFA Feyenoord–Leverkusen](https://www.uefa.com/uefachampionsleague/match/2042028--feyenoord-vs-leverkusen/) · [UEFA Girona–Feyenoord](https://www.uefa.com/uefachampionsleague/match/2041951--girona-vs-feyenoord/)

Araştırma durumunda özgün maç kanıtı ve arşiv uyuşmazlığı ayrı saklanır. Yedi metriği içeren özgün yanıtın bulunması, farklı saati taşıyan arşiv satırına otomatik aktarım yetkisi vermez. Sağlayıcı kopyaları `related_archive_keys` alanında işaretlenir ve kaynak kimlikleri korunur.
