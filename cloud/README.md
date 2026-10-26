# موقع متابعة المبيعات (Firebase)

الموقع بيخلّي صاحب المحل يشوف مبيعاته وأرباحه من الموبايل، ويتثبّت زي تطبيق (PWA).
برنامج الكاشير بيشتغل أوفلاين دايمًا، ولما يلاقي نت بيبعت ملخص كل 15 دقيقة.

## الإعداد (مرة واحدة)

1. **مشروع Firebase:** من console.firebase.google.com اعمل مشروع جديد (الخطة المجانية Spark كفاية للبداية).
2. **تسجيل الدخول:** Build ← Authentication ← Get started ← Sign-in method ← فعّل **Email/Password**.
   بعدها من تاب Users اضغط **Add user** وسجّل إيميل وباسورد لكل عميل. الموقع مفيهوش تسجيل حساب جديد، فإنت اللي بتديهم الحساب.
3. **قاعدة البيانات:** Build ← Firestore Database ← Create database (اختار Production mode).
4. **بيانات الموقع:** Project settings ← General ← Your apps ← أضف تطبيق Web (`</>`) وانسخ القيم في الملف
   `apps/cloud/public/firebase-config.json` (`apiKey`, `authDomain`, `projectId`, `appId`). القيم دي مش أسرار.
5. **الرفع:**
   ```
   npm install -g firebase-tools
   firebase login
   copy .firebaserc.example .firebaserc      (وعدّل اسم المشروع)
   npm install
   npm run build:cloud
   firebase deploy --only hosting,firestore
   ```
   الموقع هيبقى على `https://اسم-المشروع.web.app`.
6. **برنامج الكاشير:** ملف `firebase-config.json` نفسه بيتحط جوه البرنامج وقت البناء، فاعمل commit للملف وابني الـ exe تاني.

## عند كل عميل

1. في برنامج الكاشير: الإعدادات ← «متابعة المبيعات من الموبايل» ← الإيميل والباسورد اللي إنت سجّلتهم له.
2. على موبايل العميل: افتح رابط الموقع وسجّل دخول.
   - **أندرويد (Chrome):** هيظهر شريط «تثبيت»، أو من القايمة اختار Install app.
   - **آيفون (Safari):** زر المشاركة ← إضافة إلى الشاشة الرئيسية.

## الأمان
- قواعد Firestore (`cloud/firestore.rules`) بتخلّي كل حساب يقرا ويكتب في محله بس.
- الباسورد مش بيتخزّن في البرنامج، بيتحفظ بس مفتاح تجديد دخول خاص بحساب المحل.
- لو عميل وقف اشتراكه: عطّل حسابه من Authentication ← Users.

## التكلفة
الخطة المجانية فيها 20 ألف كتابة في اليوم. كل محل بيكتب في المتوسط حوالي 500 مرة في اليوم، فتقريبًا 35 محل لكل مشروع قبل ما تحتاج خطة Blaze (دفع حسب الاستخدام، رخيصة).

## معاينة التصميم بدون Firebase
```
npx tsx tools/cloud-mock-fixture.ts
npm run build:mock -w @market/cloud
```
