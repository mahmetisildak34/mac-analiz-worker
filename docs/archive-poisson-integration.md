# Arşiv ve Poisson entegrasyonu

Bu sözleşme Worker PR #69 içindir. Gizli bilgi, API-Football isteği veya D1 yazma işlemi gerektirmez.

## Arşiv

`GET /api/archive/matches?league=39&before=2026-11-08&limit=4`

| Parametre | Davranış |
| --- | --- |
| `league` | Zorunlu arşiv lig kimliği |
| `before` | Hariç tutulan üst sınır. UTC ISO tarih veya saat kullanın |
| `limit` | 1–2000, varsayılan 1500 |
| `teamNames` | Virgülle ayrılmış adlar. Önce lig sorgusu ve limit, ardından takım filtresi uygulanır |

Başarılı yanıtta `response` maç dizisi, `count` dönen maç sayısı ve `rawCount` takım filtresi öncesi sayıdır. `data_quality_counts` dönen maçları istatistik durumuna göre sayar. [Gerçek ESPN olayından yerel Worker ile üretilen örnek](archive-espn-example.json).

| Alan | Sözleşme |
| --- | --- |
| `source`, `mamSource` | Aynı kaynak etiketi. Eski istemciler mevcut `source` alanını kullanabilir |
| `identity_verified`, `score_verified` | Boolean. Kimlik ve bitmiş maç skoru ayrı kanıtlanır. Eski yanıtlardaki eksik alanı `false` gibi ele alın |
| `verification_evidence` | `archived_espn_provider_payload`, `archived_api_football_provider_payload` veya `unknown` |
| `fixture`, `league`, `teams`, `goals`, `score` | Mevcut arşiv alanları. `score` devre arası kanıtı yoksa `null` olabilir |
| `statistics` | Saklanan sağlayıcı biçimi ya da `null`. Ekipler `teams` veya `response` dizisinde bulunabilir |
| `data_quality.status` | `missing`, `partial`, `conflicting`, `provenance_review` veya `verified_full`. Bu arşiv okuması yapısal kaliteyi kontrol eder. Tam metrik seti veri kökeni ayrıca doğrulanmadıkça `provenance_review` kalır |

Yedi metrik toplam şut, isabetli şut, topa sahip olma, korner, faul, sarı kart ve kırmızı karttır. Kayıp metrikleri sıfırla doldurmayın. Yanıtın eski `statistics` nesnesi aynen iletilir.

| HTTP | Durum |
| --- | --- |
| 400 | Lig eksik, tarih biçimi geçersiz veya API yolu geçersiz |
| 403 | İzin verilmeyen tarayıcı origin’i |
| 405 | Desteklenmeyen yöntem |
| 503 | D1 yok veya arşiv sorgusu başarısız. Sorgu hatasında yanıt `retryable` içerebilir |

## Poisson

`predictTrustedGoals(matches, options)` bir JS modülü. Bu PR ayrı bir Poisson HTTP uç noktası sunmaz. Arşiv satırından `source`, `fixture.id`, `fixture.date`, `fixture.status.short`, sıralı takım adları, goller ve iki doğrulama bayrağını modül girdisine eşleyin. Kullanılacak girdiyi aynı ligdeki tamamlanmış 90 dakikalık maçlarla sınırlandırın. `as_of` tahmin anı, lig iç/deplasman gol ortalamaları o andan önceki tamamlanmış lig maçlarından hesaplanmalıdır.

- Başarı çıktısında `available: true`, `lambda_home`, `lambda_away`, `home_samples`, `away_samples`, `probabilities`, `most_likely_scores` ve kullanılan maçlar `used_fixtures` bulunur. Olasılıklar 0–1 aralığındadır. Saha ve karşı tarafın ilgili saha gol yeme ortalaması hesaba katılır. Ayrı rakip derecelendirmesi uygulanmaz.
- Başarısız çıktıda `available: false` ve `reason` vardır. `insufficient_verified_venue_sample` için taraf başına varsayılan minimum beştir. `missing_league_averages`, `invalid_request`, `invalid_teams`, `invalid_expected_goals`, `probability_mass_truncated` ve `probability_invariant_failed` de tahminin gösterilmemesini gerektirir.
- `data_quality.reliability` örneklem boyutunu anlatır. Ölçülmüş doğruluk veya kalibre edilmiş güven yüzdesi olarak gösterilmemelidir.
- Sayısal doğrulama ve kalibrasyon sonuçları [geriye dönük test raporunda](poisson-backtest.md).

## v1.1 istemci alanları

Arşiv HTTP yolu sürüm eki taşımaz. Yeni alanlar mevcut yanıtla birlikte gelir. Model modülü her sonuçta `model_version`, `calibration_status` ve tahmin sınırı `as_of` sağlar. `latest_fixture_kickoff` kullanılan en yeni maçın başlangıç zamanıdır. Sağlayıcının güncelleme zamanı bu yanıtta mevcut değildir. `used` toplam örneklem, `home_samples` ve `away_samples` saha ayrımıdır. `lambda_home` ve `lambda_away` beklenen goller, `probabilities` 1X2, BTTS ve 2,5 gol alt/üst değerleridir. `most_likely_scores` ile `other_score_probability` toplamı 1’dir.

`league_id` ve hedef takım kimlikleri verilirse uyuşmayan veya eksik kimlikler ilgili örneklemden çıkarılır. Saha ve lig düzeyi filtresini kullanın. İptal, erteleme ve askıya alınma durumu bitmiş olarak işaretlenmiş satırlarda da tahmine girmez.

`calibration_status: "uncalibrated"` iken bir olasılığı doğruluk veya güven oranı gibi göstermeyin. Normal tahmin, eksik lig verisi, yetersiz maç ve API hatası için [üretilmiş JSON örnekleri](poisson-integration-examples.json). Profesyonel model adayları [altı lig deneyinde](poisson-six-league-benchmark.json) karşılaştırıldı. Araştırma modelleri mevcut tahmin yoluna eklenmedi.

## v1.2 dönemler ve gol dağılımları

Worker arşiv uç noktası hâlâ `GET /api/archive/matches`. Bu sürüm bağımsız bir tahmin HTTP uç noktası eklemez. İstemci, `predictTrustedGoals(matches, options)` ile maç sonunu ve `predictTrustedHalfTime(matches, options)` ile ilk yarıyı hesaplar. İki sonucun `period` değeri sırasıyla `full_time` ve `first_half`.

| Alan | Kullanımı |
| --- | --- |
| `probabilities` | 1X2, BTTS ve geriye uyumlu 2,5 alt/üst alanları |
| `totals` | `"0.5"` ile `"4.5"` arasındaki beş eşik. Her anahtar `{ over, under }` içerir |
| `goal_distribution.home`, `.away`, `.total` | Dizi indeksi gol adedidir. Her dizinin toplamı 1’dir |
| `goal_distribution.retained_mass` | Normalize edilmeden önce hesaplanan skor kütlesi. Kütle yetersizse tahmin dönmez |
| `most_likely_scores`, `other_score_probability` | İlk beş skor ve geri kalan skorların toplam olasılığı |
| `lambda_home`, `lambda_away` | Seçilen dönemde beklenen gol. Şut tabanlı xG alanı değildir |
| `team_rates`, `used_fixtures` | Seçilen dönem ve saha için hücum/savunma oranları ile kullanılan kaynak maçlar |

İlk yarı girdisi aynı kimlik ve zaman alanlarına ek olarak `halftime_home_goals`, `halftime_away_goals` ve `halftime_score_verified` taşır. İlk yarı seçeneklerinde `league_average_home_half_goals` ve `league_average_away_half_goals` zorunludur. Arşivde `halftime_score_verified === true` ise `score.halftime.home` ve `.away` değerlerini eşleyin. Worker bu bayrağı yalnızca tanıdığı özgün sağlayıcı biçiminde, doğrulanmış maç sonu kaydıyla tutarlı bir devre skoru varsa etkinleştirir. Eksik, null veya doğrulanmamış devre alanını sıfıra çevirmeyin. Maç sonu golleri ilk yarı hesabında kullanılmaz.

[Maç sonu, ilk yarı ve hata örnekleri](poisson-integration-examples.json) · [Tarihsel pazar testi](poisson-market-benchmark.json) · [Ek Süper Lig holdout testi](poisson-turkey-holdout.json)

## Ağ erişimi olmadan entegrasyon testi

`trusted-goal-poisson.js` standart bir JavaScript ES modülü. Harici paket, HTTP çağrısı, Cloudflare binding’i veya token gerektirmez. `archive-espn-example.json` yerel Worker tarafından oluşturulan arşiv yanıtıdır. `poisson-integration-examples.json` gerçek geçmiş maç verilerinden oluşturulan tahminleri ve kontrollü hata yanıtlarını içerir.

```js
import { createOfflineAnalysisFixtureClient } from "./offline-analysis-fixture-client.js";
import examples from "./poisson-integration-examples.json" with { type: "json" };
import archive from "./archive-espn-example.json" with { type: "json" };

const client = createOfflineAnalysisFixtureClient(examples, archive);
const history = await client.getArchive();
const full = await client.getAnalysis("full_time");
const half = await client.getAnalysis("first_half");
const missing = await client.getAnalysis("missing_data");
const tooFew = await client.getAnalysis("insufficient");
const retry = await client.getAnalysis("api_error");
```

JSON modülü desteklenmeyen test ortamında aynı iki dosyayı test yükleyicisiyle ayrıştırıp fabrikaya nesne olarak verin. Çevrimdışı istemci her çağrıda ayrı bir kopya döndürür. `getAnalysis` senaryoları test yardımcısıdır. Canlı arşiv endpoint’i `GET /api/archive/matches`.

Tahmin çağrısında `available === false` iken `probabilities` bulunmaz. Örneklem oluşturulmadan durulan yanıtlarda `home_samples` ve `away_samples` değeri `null` olur. Örneklem yetersizse bulunan gerçek sayılar döner. `completed: false` ile bitmiş durum etiketi çelişen maçlar örnekleme alınmaz.

[Tüm pazarlar için lig sıklığı, basit lig Poisson ve saha Poisson karşılaştırması](poisson-market-baselines.json). Aynı maçlar üzerinden Brier, log loss ve kalibrasyon hatası karşılaştırılır. Marjinal gol dağılımları ve kesin skor değerlendirmesi de rapordadır.

Deneysel karma modelin lig ve dönem bazındaki ağırlığı Ocak–Haziran 2025 doğrulamasında seçilir. Temmuz 2025 sonrası test maçları ağırlık seçiminde kullanılmaz. İlk yarıda saha Poisson modelinin 1X2 log loss değeri 1,2316, lig sıklığının 1,0895 ve karma modelin 1,0865. Karma modelin kalibrasyon hatası 0,0322, lig sıklığının 0,0117. Sonuçlar karma modeli varsayılan tahmin yoluna geçirmeden kaydedildi.
