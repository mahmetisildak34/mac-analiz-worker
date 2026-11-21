# Poisson v1.3 deney sonuçları

Veri kaynağı [OpenFootball anlık görüntüsü](https://github.com/openfootball/football.json/tree/e6744429ee395bc86f247348c6184bb08d4eb361). Eğitim 1 Ocak 2025 öncesi, ayar seçimi Ocak–Haziran 2025, test 1 Temmuz 2025 ve sonrasıdır. Tahminler ilerleyen tarihlerde yalnızca tamamlanmış önceki günlerden güncellenir. İlk yarı deneyi yalnızca devre skoruyla çalışır. Adaylar aynı maçlar üzerinde karşılaştırılır. Tablodaki ECE, en yüksek 1X2 olasılığının kalibrasyon hatasıdır.

Ev avantajı deneyinde son 80 maçtaki lig ev/deplasman gol oranı kullanılır. Karma model, saha Poisson skor dağılımını geçmiş lig skor frekansıyla birleştirir. Karma ağırlığı ve kalibrasyon sıcaklığı lig ve dönem bazında yalnızca doğrulama döneminde seçilir. Dixon–Coles katsayısı deney öncesinde sabittir. Elo adayında lig içi derecelendirme maç gününün sonunda güncellenir. Süper Lig için üç eski sezon eğitim geçmişine eklendi.

## Maç sonu

| Lig | Ortak / toplam | v1.2 Brier / log loss / ECE | Testte en düşük log loss | Aday Brier / log loss / ECE |
| --- | ---: | --- | --- | --- |
| tr.1 | 78 / 90 | 0.6271 / 1.0430 / 0.1489 | elo | 0.5726 / 0.9638 / 0.1152 |
| en.1 | 365 / 398 | 0.6254 / 1.0465 / 0.0594 | elo | 0.5961 / 0.9980 / 0.0377 |
| es.1 | 368 / 429 | 0.6106 / 1.0256 / 0.0594 | elo | 0.5822 / 0.9810 / 0.0558 |
| de.1 | 287 / 327 | 0.6169 / 1.0410 / 0.0856 | elo | 0.5827 / 0.9810 / 0.0443 |
| it.1 | 369 / 394 | 0.5988 / 1.0168 / 0.0748 | elo | 0.5756 / 0.9766 / 0.0544 |
| fr.1 | 286 / 323 | 0.6010 / 1.0187 / 0.0499 | elo | 0.5771 / 0.9744 / 0.0386 |

## İlk yarı

| Lig | Ortak / toplam | v1.2 Brier / log loss / ECE | Testte en düşük log loss | Aday Brier / log loss / ECE |
| --- | ---: | --- | --- | --- |
| tr.1 | 80 / 90 | 0.6916 / 1.1710 / 0.1774 | dynamic_home | 0.6491 / 1.0745 / 0.1043 |
| en.1 | 370 / 398 | 0.6781 / 1.1335 / 0.1438 | calibrated | 0.6307 / 1.0451 / 0.0373 |
| es.1 | 383 / 429 | 0.6946 / 1.1691 / 0.1525 | league_mix | 0.6375 / 1.0534 / 0.0291 |
| de.1 | 309 / 327 | 0.6720 / 1.2309 / 0.1131 | calibrated | 0.6313 / 1.0454 / 0.0682 |
| it.1 | 375 / 394 | 0.6955 / 1.3456 / 0.1471 | calibrated | 0.6466 / 1.0663 / 0.0428 |
| fr.1 | 304 / 323 | 0.7081 / 1.1802 / 0.1319 | league_mix | 0.6591 / 1.0864 / 0.0261 |

Tabloda adı verilen yöntemler test sonrası betimleyici karşılaştırmadır. v1.2 uygulama varsayılanı olarak kalır. Özellikle Türkiye ilk yarı ve maç sonu örneklemlerinin boyutu ile ECE değerleri model değişikliğini desteklemiyor. Maç sonu ve ilk yarı test kapsamları, 0,60–0,70, 0,70–0,80 ve 0,80–0,90 dahil dolu kalibrasyon aralıkları ile maç sayıları [maç sonu](poisson-v13-full-time.json) ve [ilk yarı](poisson-v13-first-half.json) JSON’larında yer alır. Belirli bir aralığın olmaması gözlem bulunmadığını gösterir.

[Çifte şans, BTTS, 0,5–4,5, kesin skor ve gol dağılımı](poisson-market-baselines.json) için Brier, log loss, ECE ve kapsama ayrı raporlanır. Bu rapor, 2024/25 ve 2025/26 sezonlarıyla oluşturulan önceki pazar veri kümesini kullanır.

## Lig ve pazar bazında ölçümler

[Maç sonu tüm ligler](poisson-v13-markets-full.json) ve [ilk yarı tüm ligler](poisson-v13-markets-half.json) her model için 1X2, üç çifte şans, karşılıklı gol, beş gol eşiği, iki takımın gol adedi ve kesin skor sonuçlarını içerir. Olasılıklar tek skor dağılımından türetilir. `coverage` modelin tüm test fikstürlerindeki uygunluk oranıdır. `markets.*.n` ortak değerlendirme örneklemi sayısıdır. ECE, ikili pazarlarda olay olasılığına, çok sınıflı pazarlarda en yüksek olasılığa göre on aralık üzerinden hesaplanır. `expected_goal_mean` dağılımdan elde edilen ortalama model gol beklentisidir. Şut tabanlı sağlayıcı xG'si kullanılmaz.

Yeni adaylar son beş ve on maçın üstel ağırlıklı sürümleri, ayrı iç/dış saha hücum ve savunma oranlarıyla rakip düzeltmesi ve doğrulama döneminde sıcaklığı seçilen Elo'dur. Ağırlıklı yöntemlerde küçük örneklem için lig ortalaması kullanılır. Tahmin edilebilirlik için saha yöntemleri taraf başına en az beş uygun geçmiş maç ister. İlk yarı verisi yalnızca devre skoru sütunlarından oluşturulur.

[Ek Süper Lig maç sonu deneyi](poisson-turkey-expanded-full.json) ve [ilk yarı deneyi](poisson-turkey-expanded-half.json), Football-Data.co.uk 2024/25 ve 2025/26 sezonlarından oluşturuldu. Kaynak CSV bağlantıları ve SHA-256 değerleri sonuç dosyalarındadır. Aynı ayrım ve parametre adayları kullanıldı. OpenFootball ve Football-Data örneklemleri kısmen aynı maçları içerdiğinden iki sonuç bağımsız doğrulama sayılmaz.

| Süper Lig | Ortak / toplam | v1.2 log loss / ECE | Elo log loss / ECE | Kalibre Elo log loss / ECE | Karma log loss / ECE |
| --- | ---: | --- | --- | --- | --- |
| Maç sonu | 273 / 306 | 1,0902 / 0,1027 | 1,0240 / 0,0643 | 1,0240 / 0,0643 | 1,0276 / 0,0257 |
| İlk yarı | 276 / 306 | 1,1480 / 0,1681 | 1,0627 / 0,0664 | 1,0614 / 0,0521 | 1,0577 / 0,0184 |

Maç sonunda doğrulama döneminin seçtiği Elo sıcaklığı 1, ilk yarıda 1,3'tür. Karma model Süper Lig ilk yarısında tabloda gösterilen yöntemler arasında hem daha düşük log loss hem daha düşük ECE verdi. Kararlı v1.2 uygulama varsayılanı olarak kalır.

```sh
node scripts/benchmark-poisson-models.mjs /path/to/openfootball --extended --markets
node scripts/benchmark-poisson-models.mjs /path/to/openfootball --extended --markets --half
python3 scripts/prepare-turkey-benchmark.py /path/to/turkey-csv /tmp/turkey-benchmark
node scripts/benchmark-poisson-models.mjs /tmp/turkey-benchmark --turkey-only --markets
node scripts/benchmark-poisson-models.mjs /tmp/turkey-benchmark --turkey-only --markets --half
```
