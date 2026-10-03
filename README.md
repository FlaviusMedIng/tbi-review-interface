# Interface de validation — scoping review (boxe / TBI)

Site statique de validation pour l'équipe de la revue. Les données (`data/*.enc.json`) sont chiffrées
(AES-256-GCM, clé dérivée par PBKDF2-SHA256, 600 000 itérations) et illisibles sans la phrase secrète,
transmise aux relecteurs par un autre canal. Aucune donnée en clair n'est publiée ici.
