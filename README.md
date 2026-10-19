# Draft Koçu

Takım için League of Legends draft yardımcısı. Champ select'i League istemcisinden canlı okur, her oyuncunun şampiyon havuzuna göre öneri verir, draft'ları ve maç sonuçlarını takımın ortak veritabanına kaydeder.

## Nasıl çalışır

```
Her oyuncunun bilgisayarı                         Bulut (Supabase)
┌───────────────┐   LCU (yerel)   ┌──────────────┐        ┌──────────────────────┐
│ League Client │ ─────────────── │ Draft Koçu   │ ─────> │ Postgres veritabanı  │
└───────────────┘                 │ (Electron)   │ <───── │ Auth, Realtime       │
                                  └──────────────┘        │ Edge Function + cron │
                                                          └──────────────────────┘
```

- **Masaüstü uygulaması (Electron):** League istemcisinin yerel API'sine (LCU) bağlanır. Banlar, iki takımın pick'leri, sıranın kimde olduğu ve süre anlık gelir; rakip takımı elle girmek gerekmez.
- **Supabase:** Ortak veri deposu. Şampiyon listesi, oyuncu havuzları, draft geçmişi, maç sonuçları ve ileride meta/counter verisi burada durur. Biri havuzunu değiştirince diğerlerinin uygulaması anında güncellenir.
- **Zamanlanmış iş:** Her gün Riot Data Dragon'dan güncel patch'i ve şampiyon listesini çeker. Veri toplayıcı (meta/counter) aynı yapıya eklenecek.

Her oyuncu uygulamayı kendi bilgisayarında çalıştırır. Aynı maçı birden fazla kişi kaydederse veritabanında tek kayıt kalır.

## Klasörler

```
supabase/
  migrations/0001_init.sql      Tablolar, güvenlik kuralları (RLS), takım kurma/katılma
  functions/sync-ddragon/       Şampiyon listesini güncelleyen Edge Function
  cron.sql                      Fonksiyonu her gün çalıştıran zamanlama
desktop/
  src/main/lcu.js               League istemcisini bulma ve bağlantı
  src/main/champselect.js       LCU champ select verisini sade draft modeline çevirme
  src/main/endofgame.js         Maç sonu istatistiklerini okuma
  src/main/core.js              Draft takibi ve kayıt mantığı
  src/main/data.js              Supabase işlemleri
  src/main/main.js              Electron penceresi ve arayüz köprüsü
  src/renderer/                 Arayüz (draft, havuz, takım, geçmiş)
  src/renderer/recommend.js     Öneri motoru (şimdilik konfor + meta puanı)
  test/                         Testler ve sahte League istemcisi
```

## Kurulum

Bu adımları takımda **bir kişi** bir kez yapar.

### 1. Supabase projesi

1. [supabase.com](https://supabase.com) üzerinden ücretsiz bir proje açın.
2. **SQL Editor**'da `supabase/migrations/0001_init.sql` dosyasının içeriğini çalıştırın.
3. **Authentication > Sign In / Providers > Email** altında, isterseniz "Confirm email" seçeneğini kapatın. Açık kalırsa her oyuncu kayıt sonrası e-postasındaki bağlantıya tıklamalı.

### 2. Şampiyon listesi senkronu

1. **Edge Functions > Deploy a new function > Via Editor** ile `sync-ddragon` adında bir fonksiyon oluşturun ve `supabase/functions/sync-ddragon/index.ts` içeriğini yapıştırın.
2. Fonksiyonun ayarlarında **Enforce JWT Verification** seçeneğini kapatın (fonksiyon kendi parolasını kontrol ediyor).
3. **Edge Functions > Secrets** altına `CRON_SECRET` adında, uzun rastgele bir değer ekleyin.
4. `supabase/cron.sql` dosyasındaki `<PROJECT_REF>` ve `<CRON_SECRET>` değerlerini doldurup SQL Editor'da çalıştırın.
5. İlk listeyi hemen almak için fonksiyonu bir kez elle çağırın:
   ```
   curl -X POST https://<PROJECT_REF>.supabase.co/functions/v1/sync-ddragon -H "x-cron-secret: <CRON_SECRET>"
   ```
   Yanıt `{"ok":true,"patch":"...","champions":...}` olmalı.

Supabase CLI kullanıyorsanız 1-2. adımlar yerine `supabase functions deploy sync-ddragon` yeterli (`supabase/config.toml` JWT ayarını içeriyor).

### 3. Uygulama ayarı

`desktop/config.example.json` dosyasını `desktop/config.json` olarak kopyalayıp doldurun:

- `supabaseUrl`: **Project Settings > API** altındaki proje adresi
- `supabaseKey`: aynı sayfadaki **publishable** (veya eski adıyla **anon**) anahtar

Bu anahtar herkese açık kullanılmak üzere tasarlanmıştır; veriyi koruyan şey veritabanındaki güvenlik kurallarıdır. Yine de `config.json` repoya girmez (`.gitignore`). **service_role / secret** anahtarını asla buraya yazmayın.

## Geliştirme

Node.js 22 gerekir.

```bash
cd desktop
npm install
npm start
```

### League açmadan denemek

Sahte bir League istemcisi, bir turnuva draft'ını, oyunu ve maç sonunu sırayla oynatır:

```bash
# 1. terminal
npm run dev:mock
# yazdığı LCU_LOCKFILE yolunu kopyalayın

# 2. terminal (PowerShell)
$env:LCU_LOCKFILE="<yol>"; npm start
# macOS / Linux
LCU_LOCKFILE=<yol> npm start
```

Draft'ın kaydedilmesi için giriş yapmış ve bir takıma katılmış olmanız gerekir.

### Testler

```bash
npm test
```

Testler champ select dönüşümünü, maç sonu okumayı ve sahte istemciyle uçtan uca akışı (bağlanma, draft kaydı, dodge, maç sonucu) kontrol eder. Veritabanı güvenlik kuralları ayrıca Postgres üzerinde üç farklı kullanıcıyla denendi.

## Takıma dağıtma

Repo GitHub'dayken:

1. **Settings > Secrets and variables > Actions** altına `SUPABASE_URL` ve `SUPABASE_KEY` ekleyin.
2. Bir sürüm etiketi gönderin:
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```
3. GitHub Actions Windows kurulum dosyasını üretip **Releases** sayfasına koyar. Takım arkadaşları exe'yi oradan indirir.

Exe imzasız olduğu için Windows ilk açılışta "bilinmeyen yayıncı" uyarısı gösterebilir: **Ek bilgi > Yine de çalıştır**.

Kendi bilgisayarınızda üretmek için (Windows): `npm run dist` → `desktop/dist/`.

## Kullanım

1. Uygulamayı açın, hesap oluşturun.
2. Profilinizi (takma ad, ana rol) kaydedin.
3. Takımda ilk kişi takımı kurar, **Takım** sekmesindeki davet kodunu paylaşır; diğerleri bu kodla katılır.
4. **Havuzum** sekmesinden oynadığınız şampiyonları rol ve konfor puanıyla ekleyin.
5. League açıkken uygulama istemciyi kendiliğinden bulur ve LoL hesabınızı profilinize bağlar. Champ select başladığında **Draft** sekmesi canlı güncellenir.

## Yol haritası

- [x] **1. aşama:** LCU'dan canlı draft, takım ve havuzlar, draft + maç sonu kaydı, günlük şampiyon senkronu
- [ ] Veri toplayıcı: meta ve counter verisini `meta_scores`, `matchups`, `synergies` tablolarına yazan zamanlanmış iş
- [ ] Strateji motoru: meta puanı ve kompozisyon uyumu (`recommend.js`)
- [ ] **2. aşama:** Riot API ile oyuncu istatistikleri
- [ ] **3. aşama:** Maç verisinden eğitilen kendi tahmin modeli

## Not

Draft Koçu, Riot Games tarafından onaylanmamıştır ve Riot Games'in ya da League of Legends'ın üretiminde veya yönetiminde yer alan kişilerin görüşlerini yansıtmaz. League of Legends ve Riot Games, Riot Games, Inc.'in ticari markalarıdır.
