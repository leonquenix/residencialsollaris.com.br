# 🎪 Festa do Dia das Crianças — vouchers com QR Code

Sistema mínimo pra distribuir e validar vouchers (pipoca, algodão doce, etc.) na festa do condomínio.

- **Admin** cadastra moradores (CPF + senha) e os vouchers de cada um.
- **Cliente** (morador) entra com CPF e senha e vê seus vouchers como QR Code. A tela atualiza sozinha quando um voucher é usado.
- **Vendedor** aponta a câmera do celular pro QR Code e valida. Se a câmera falhar, digita o código (`CPF-número`, ex. `43073902880-1`).

## Arquitetura (de propósito, o mais simples possível)

```
navegador (HTML/CSS/JS puro)  ──HTTPS──▶  Caddy  ──▶  Node + Express (server.js)  ──▶  SQLite (data/festa.db)
```

| Peça | Escolha | Por quê |
|---|---|---|
| Servidor | Node 22+ e Express | um processo, um arquivo `server.js` |
| Banco | SQLite via `node:sqlite` (embutido no Node) | zero instalação, zero dependência nativa, um arquivo em `data/` |
| Sessão | cookie assinado (`cookie-session`) | nada pra guardar no servidor |
| Senhas | `bcryptjs` | hash puro JS |
| QR Code | gerado no servidor (`qrcode`), lido no navegador (`jsQR` + câmera) | sem app, funciona no celular |
| HTTPS | Caddy | certificado automático; a câmera exige HTTPS |
| Frontend | 4 páginas HTML estáticas + um CSS | sem build, sem framework |

Arquivos:

```
server.js        rotas da API e das páginas
db.js            schema e consultas SQLite
public/          login.html, cliente.html, vendedor.html, admin.html, style.css, app.js
data/            banco e segredo de sessão (criados na primeira execução; fora do git)
Caddyfile        proxy HTTPS
deploy/festa.service   unidade systemd
```

Modelo de dados: `users (login, name, role, password_hash)`, `vouchers (user_id, seq, code, label, redeemed_at, redeemed_by)` e `voucher_types (name)`. Os tipos padrão são **Suco**, **Cachorro-quente** e **Picolé**; o admin pode criar ou remover tipos no painel, e cada tipo vira um campo numérico no cadastro (ex.: Suco 5, Cachorro-quente 6 gera 11 vouchers). O `code` é `login-seq`, é o conteúdo do QR Code e o que o vendedor digita à mão. A validação é um único `UPDATE ... WHERE redeemed_at IS NULL`, então dois vendedores nunca validam o mesmo voucher.

## Rodando local

```bash
npm install
npm start
```

Abra http://localhost:3000. Na primeira execução é criado o admin `admin` / `admin123` (troque no painel). Pra mudar o login/senha iniciais, copie `.env.example` pra `.env` antes de rodar.

## Deploy numa VPS (Ubuntu/Debian)

Atalho (como root na VPS; instala Node, Caddy, o serviço e configura o domínio):

```bash
curl -fsSL https://raw.githubusercontent.com/leonquenix/vouncher-system/main/deploy/setup.sh | bash -s -- festa.seudominio.com.br
```

Rodar o mesmo comando de novo atualiza o app. Passo a passo manual:

```bash
# 1. Node 22 (LTS)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. App
sudo useradd -r -m -d /opt/festa festa
sudo git clone <url-do-repo> /opt/festa
cd /opt/festa && sudo npm install --omit=dev
sudo cp .env.example .env && sudo nano .env      # defina ADMIN_PASSWORD
sudo chown -R festa:festa /opt/festa

# 3. Serviço
sudo cp deploy/festa.service /etc/systemd/system/
sudo systemctl enable --now festa
sudo systemctl status festa

# 4. HTTPS com Caddy (aponte o DNS do domínio pro IP da VPS antes)
sudo apt-get install -y caddy
sudo cp Caddyfile /etc/caddy/Caddyfile && sudo nano /etc/caddy/Caddyfile   # troque o domínio
sudo systemctl reload caddy
```

Atualizar depois: `cd /opt/festa && sudo git pull && sudo npm install --omit=dev && sudo systemctl restart festa`.

Backup: é só copiar `data/festa.db`.

## Uso no dia

1. **Admin → Importar lista**: cole uma linha por morador no formato `CPF;Nome;Senha;Suco=5|Cachorro-quente=6|Picolé=2` (ou cole direto do Excel, com Tab). Guarde a planilha: as senhas ficam só em hash no banco.
2. **Admin → Cadastrar**: cadastre uma pessoa por vez informando a quantidade de cada tipo de voucher; crie também os vendedores (tipo *Vendedor*, CPF e senha). Novos tipos de voucher são criados na mesma tela.
3. Entregue CPF e senha a cada família. Elas entram pelo celular e veem os QR Codes.
4. O vendedor entra no celular dele e aponta a câmera. Ao reconhecer o QR (ou ao digitar o código), abre um pop-up com o voucher e o nome do morador; nada é consumido até tocar em **Confirmar**. Vermelho = já consumido ou inexistente.
5. Na tela do morador o voucher consumido não sai da lista: fica cinza com o carimbo **CONSUMIDO** e a data/hora.
6. Se precisar, o admin pode **desfazer** um uso ou adicionar vouchers a alguém pela tela *Pessoas*.

## Variáveis de ambiente

| Variável | Padrão | Uso |
|---|---|---|
| `PORT` | `3000` | porta HTTP local |
| `ADMIN_LOGIN` / `ADMIN_PASSWORD` | `admin` / `admin123` | só na primeira execução, com banco vazio |
| `SESSION_SECRET` | gerado em `data/session-secret` | assina o cookie de sessão |
| `DATA_DIR` | `./data` | onde fica o banco |
