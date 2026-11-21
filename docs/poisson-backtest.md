# Premier League Poisson geriye dönük testi

İki sezon ayrı ayrı yürütüldü. Her sezonun 380 tamamlanmış maçında hedef gün hariç tutuldu. Modelin hem lig ortalamaları hem de takım örnekleri yalnızca önceki günlerden hesaplandı. Karşılaştırma tahmini, aynı değerlendirme maçları için önceki günlerin Laplace düzeltmeli 1X2 sıklığıdır. Model asgari beş iç saha ve beş deplasman örneği ister. Örneklem veya olasılık kütlesi denetimini geçemeyen maçlar değerlendirme dışıdır.

| Sezon | Üst örneklem | Maç | Brier 1X2 | Log loss | ECE | Baseline Brier | Baseline log loss | Baseline ECE |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2024/25 | 5 | 257 | 0.6627 | 1.2409 | 0.1300 | 0.6571 | 1.0833 | 0.0291 |
| 2024/25 | 10 | 268 | 0.6274 | 1.0507 | 0.0858 | 0.6573 | 1.0835 | 0.0185 |
| 2025/26 | 5 | 274 | 0.6892 | 1.1389 | 0.1424 | 0.6700 | 1.1033 | 0.0565 |
| 2025/26 | 10 | 277 | 0.6740 | 1.1114 | 0.1153 | 0.6725 | 1.1072 | 0.0610 |

Brier üç sınıfın kare hataları toplamının ortalamasıdır. ECE, en olası sınıf için on eşit genişlikli kutu üzerinden hesaplanır. 10 maçlık üst sınır için BTTS ve 2.5 üst Brier değerleri 2024/25’te **0.2707 / 0.2588**, 2025/26’da **0.2816 / 0.2952**. Modelin 2024/25 10 maç sonucu Brier ve log loss’ta daha iyi. 2025/26’da iki ölçümde de lig sıklığının gerisinde. ECE dört karşılaştırmada da daha yüksek. Bu sonuç, model olasılıklarını kalibre edilmiş güven yüzdesi olarak sunmayı desteklemiyor.

Kaynaklar: [2024/25 CSV](https://www.football-data.co.uk/mmz4281/2425/E0.csv), SHA-256 `d0c8ce4a96d886cf60cf101f570f4a3893844226f91c7bd769eb568c49edbfa4` ve [2025/26 CSV](https://www.football-data.co.uk/mmz4281/2526/E0.csv), SHA-256 `3e3a8352f9ada6789c508d6ca184424421fed56a30400904a4a327c583407e62`. Bunlar test verisi. Canlı uygulamanın D1 doğrulama bayrakları, CSV testindeki kaynağı temsil eden bayraklardan bağımsızdır.

Yeniden çalıştırmak için CSV alanları `Date`, `HomeTeam`, `AwayTeam`, `FTHG`, `FTAG` değerlerini maç dizisine dönüştürün. `kickoff` biçimi `YYYY-MM-DD`, goller tam sayı, maç kimliği lig ve sezon içinde benzersiz olmalıdır. JSON kök alanları `source`, `sourceSha256` ve `matches`. Her maç `source`, `fixture_id`, `kickoff`, `home_team`, `away_team`, `home_goals`, `away_goals`, `identity_verified`, `score_verified`, `completed` alanlarını içerir.

```sh
node scripts/backtest-poisson.mjs season.json
```
