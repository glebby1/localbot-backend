# Backend — Endpoints à créer

## Dashboard API (`api/dashboard.js`)

### GET /api/merchant/:merchantId
Retourner les infos complètes du merchant :
```sql
SELECT * FROM merchant WHERE id = $1
```
Réponse : `{ merchant: { id, name, type, address, email, phone, hours, services, rules, capacity, tone, use_emoji, vouvoyer, auto_reminder, system_prompt, ... } }`

---

### PATCH /api/merchant/:merchantId
Mettre à jour les infos du merchant + system_prompt généré.
Body accepté : `{ name, type, address, email, phone, hours, services, rules, capacity, tone, use_emoji, vouvoyer, auto_reminder, system_prompt }`
```sql
UPDATE merchant SET name=$1, type=$2, ... WHERE id=$N
```
Réponse : `{ ok: true }`

---

### PATCH /api/merchant/:merchantId/reservations/:reservationId
Annuler une réservation.
Body : `{ status: 'cancelled' }`
```sql
UPDATE reservation SET status = $1 WHERE id = $2 AND conversation_id IN (
  SELECT id FROM conversation WHERE merchant_id = $3
)
```
Réponse : `{ ok: true }`

---

### DELETE /api/merchant/:merchantId/faq/:faqId
Supprimer une entrée FAQ.
```sql
DELETE FROM faq WHERE id = $1 AND merchant_id = $2
```
Réponse : `{ ok: true }`

---

### PATCH /api/merchant/:merchantId/faq/:faqId
Modifier une entrée FAQ existante.
Body : `{ question, answer }`
```sql
UPDATE faq SET question=$1, answer=$2 WHERE id=$3 AND merchant_id=$4
```
Réponse : `{ ok: true }`

---

## Notes
- Tous ces endpoints doivent passer par `requireAuth` et `merchantRateLimiter()`
- Vérifier que le `merchantId` correspond à l'utilisateur authentifié (sécurité)
- La table `merchant` doit avoir les colonnes : `tone`, `use_emoji`, `vouvoyer`, `auto_reminder`
  → Si elles n'existent pas encore, créer une migration
