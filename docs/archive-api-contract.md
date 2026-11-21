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
