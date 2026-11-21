# Arşiv API sözleşmesi

`GET /api/archive/matches?league=39&before=2026-11-08&limit=4`

| Parametre | Tür | Zorunlu |
| --- | --- | --- |
| `league` | Sayısal lig kimliği | Evet |
| `before` | ISO tarih veya saat | Hayır |
| `limit` | 1–2000 tamsayı | Hayır |

Başarılı yanıt HTTP 200, `response` maç dizisi, `count` filtre sonrası satır sayısı, `rawCount` arşiv sorgusu satır sayısı ve `data_quality_counts` içerir. Maç alanları için [özgün ESPN arşiv örneğini](archive-espn-example.json) ve [entegrasyon rehberini](archive-poisson-integration.md) kullan.

`identity_verified` ve `score_verified` ayrı kanıt bayraklarıdır. `verification_evidence` bunların kaynağını açıklar. `data_quality.status` istatistik bütünlüğünü gösterir. HTTP 503 durumunda arşiv kullanılamaz. İstemci arşiv yükleme hatası göstermeli ve tahmin çalıştırmamalıdır.

`predictTrustedGoals(matches, options)` ve `predictTrustedHalfTime(matches, options)` tarayıcıda çalışan [v1.2 fonksiyonlarıdır](../trusted-goal-poisson.js). Girdinin birimi tek maçtır. `source`, `fixture_id`, ISO `kickoff`, `home_team`, `away_team`, `identity_verified` ve doğrulanmış bitiş durumu gereklidir. Maç sonu `home_goals`, `away_goals`, `score_verified` kullanır. İlk yarı bunların yerine `halftime_home_goals`, `halftime_away_goals`, `halftime_score_verified` kullanır. Options, hedef `home_team`, `away_team`, `as_of` ve ilgili dönemin ev/deplasman lig gol ortalamalarını içerir. İlgili dönem ve diğer alanlar için [çalışır örneklere](poisson-integration-examples.json) bak.

`available: true` başarılı tahmindir. `probabilities`, `totals`, `goal_distribution`, örneklem, dönem ve model metadatası içerir. `available: false` durumunda `reason` ve kalite metadatası okunur. `probabilities` bulunmaz. Çelişkili maçlar örneklemden çıkarılır ve güvenilir örneklem yetersizse tahmin üretilmez.

Aynı ESPN fikstürünün çelişkili kopyalarını v1.2 otomatik eler. Diğer kaynakların çelişkili kayıtlarını arşiv eşleme katmanında çıkar veya `conflicting: true` ile işaretle. Kimliği belirlenmemiş sağlayıcılar arasında yalnızca takım adına dayanarak birleştirme yapma.

## Mobil entegrasyon yardımcısı

`docs/archive-poisson-client.js` içindeki `analyzeArchiveResponse({ status, body }, options)` arşiv yanıtını v1.2 girdisine çevirir. Başarılı arşiv yanıtında `fullTime` ve `firstHalf` ayrı döner. Her sekme kendi `available`, `reason`, `model_version`, `calibration_status`, `home_samples` ve `away_samples` alanlarını okur. Saha bazındaki hücum ve savunma değerleri başarılı model sonucundaki `team_rates` alanında yer alır.

Lig baz çizgilerini aynı lig ve dönem için tahmin tarihinden önceki doğrulanmış maçlardan üret. Maç sonu ve ilk yarı için lig gol ortalamaları ayrıdır. Modelin varsayılan alt sınırı her takım için beş uygun saha maçıdır ve en yeni on maç değerlendirilir. Ev sahibi için iç saha, deplasman takımı için deplasman maçları kullanılır. `league_id` ile lig kapsamını daralt. Kimlikleri biliniyorsa `home_team_id` ve `away_team_id` de sağla.

Arşiv yüklenemezse yardımcı `{ available: false, reason: "archive_unavailable", http_status: 503 }` biçiminde döner. Başarılı arşiv yüklemesi ve ilk yarı verisi eksikliği bir arada olabilir. Bu durumda maç sonu kartı kendi sonucunu gösterir ve ilk yarı kartı yetersiz örneklem mesajını okur. [Çevrimdışı mobil testler](../tests/archive-poisson-mobile.test.mjs) gerçek ESPN arşiv örneğini ve kontrollü test verilerini ayrı kullanır.

Fetch kullanan mobil istemciler `await analyzeArchiveFetchResponse(response, options)` çağrısıyla tarayıcının `Response` nesnesini doğrudan işleyebilir. HTTP 503 için örnek sonuç `{"available":false,"reason":"archive_unavailable","http_status":503}`. HTTP 200 ile gelen bozuk JSON için örnek sonuç `{"available":false,"reason":"archive_invalid_json","http_status":200}`. Her iki durumda da dönem ve olasılık alanları yoktur. HTTP 200 ile gelen geçerli arşiv JSON’u için mevcut `analyzeArchiveResponse` sözleşmesi ve iki bağımsız dönem sonucu korunur.
