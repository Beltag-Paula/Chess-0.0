# Chess-0.0
A real-time, browser-based multiplayer chess game built with Node.js, Express, Socket.io, Chess.js and Chessboard.js. Two players can join as White and Black players in order to play against each other.

---

## Features

* **Real-Time Gameplay:** by using WebSocket communication via Socket.io.
* **Turn Validation & State Management:** by using chess.js to ensure only legal chess moves, as well the checks, captures and checkmates that are legal are allowed.
* **Role Assignment:** First connection gets white pieces, second connection gets black connection.
* **Dynamic Board Orientation:** The board automatically flips for the Black player so they see the game from their own perspective.
* **Firefox-Ready Security:** Includes a custom Content Security Policy (CSP) header configuration to prevent rendering blockages on Firefox. (since I tried to see if it works in different browsers such as Brave and Firefox, and Firefox gave the most headache).

---

## Tech Stack

* **Backend:** Node.js, Express, Socket.io, chess.js
* **Frontend:** Pug (Template Engine), CSS, chessboard.js (for the interactive UI board; has also inside the jQuery)

---

## Project Structure
```text
├── public/
│   ├── imgPieces/    # This is the folder where the white*.svg and black*.svg images for the chess pieces are
│   ├── styles.css    # The CSS layout for the pug page gamePage.pug
│   └── client.js     # The client-side script code
├── views/
│   └── gamePage.pug  # the "index.html" but in pug template
├── server.js         # The server/backend
├── package.json
└── README.md
```
---

### Screenshot of development
![Gameplay Screenshot](public/imgPieces/gamePlay.jpg)

[![Video Title](https://img.youtube.com/vi/EfV3KD0RC1Y/0.jpg)](https://www.youtube.com/watch?v=EfV3KD0RC1Y) 

[![Updated](https://img.youtube.com/vi/AmU0f8L3Cic/0.jpg)](https://www.youtube.com/watch?v=AmU0f8L3Cic)

![Final Screenshot](images_demo/5.jpg)
---

### 🔗 Useful Links

* [Socket.io Documentation](https://socket.io/docs/v4/) — Learn more about the real-time web socket used here.
* [Chessboard.js API Reference](https://chessboardjs.com/examples) — Explore how the UI board handles drag-and-drop actions.
* [Chess.js Reference](https://github.com/jhlywa/chess.js/) — Explore the TypeScript chess library for chess move generation/validation, piece placement/movement, and check/checkmate/draw detection
* [Official Chess Rules (FIDE)](https://handbook.fide.com/chapter/E012018) — If you need a refresher on standard chess laws.

---

### Installation
Follow these steps to clone the project, install the required packages, and launch the server locally. Make sure you have Node.js installed on your computer.
#### 1 Clone the repository
```text
git clone https://github.com/Beltag-Paula/Chess-0.0.git
```
#### 2 Enter project directory
```text
cd Chess-0.0
```
#### 3 Install dependencies
```text
npm install
```
#### 4 Start the server (use one of the following)
```text
node server.js
```
OR (recommended if nodemon is installed)
```text
nodemon server.js
```

#### 5 Open in browser:
```text
http://localhost:3000/
```
---
#### Diagram:

```mermaid
flowchart TD

subgraph group_browser["Browser clients"]
  node_landing["Landing page<br/>Pug template<br/>[index.pug]"]
  node_player_page["Multiplayer page<br/>Pug template<br/>[gamePlayer.pug]"]
  node_bot_page["Bot game page<br/>Pug template<br/>[gameBot.pug]"]
  node_player_client["Player board client<br/>browser JS<br/>[clientPlayer.js]"]
  node_bot_client["Bot game client<br/>browser JS<br/>[clientBot.js]"]
  node_board_assets["Board assets<br/>CSS and pieces"]
  node_styles["Page styles<br/>CSS<br/>[styles.css]"]
end

subgraph group_server["Node.js process"]
  node_express["Express HTTP layer<br/>route and asset server<br/>[server.js]"]
  node_socket_gateway["Socket.io gateway<br/>realtime transport<br/>[server.js]"]
  node_role_assignment["Player role assignment<br/>session policy<br/>[server.js]"]
  node_move_handler["Authoritative move handler<br/>game command layer<br/>[server.js]"]
  node_chess_state[("chess.js game state<br/>in-memory rules engine<br/>[server.js]")]
  node_entrypoint{{"Application entry point<br/>Node.js runtime<br/>[server.js]"}}
end

subgraph group_delivery["Build and deployment"]
  node_dockerfile["Container image build<br/>Docker build"]
  node_ci_build["Docker build workflow<br/>GitHub Actions<br/>[docker-build.yml]"]
  node_package["Runtime package<br/>Node.js package manifest<br/>[package.json]"]
end

node_entrypoint -->|"configures"| node_express
node_entrypoint -->|"starts"| node_socket_gateway

node_express -->|"renders"| node_landing
node_express -->|"renders"| node_player_page
node_express -->|"renders"| node_bot_page

node_express -->|"serves"| node_player_client
node_express -->|"serves"| node_bot_client
node_express -->|"serves"| node_styles
node_express -->|"serves"| node_board_assets

node_player_page -->|"loads"| node_player_client
node_bot_page -->|"loads"| node_bot_client

node_player_client -->|"Socket.io events"| node_socket_gateway

node_socket_gateway -->|"on connection"| node_role_assignment
node_role_assignment -->|"sends role"| node_player_client

node_socket_gateway -->|"forwards move attempt"| node_move_handler
node_move_handler -->|"validates and updates"| node_chess_state
node_move_handler -->|"broadcasts state"| node_socket_gateway
node_socket_gateway -->|"state updates"| node_player_client

node_ci_build -->|"builds"| node_dockerfile
node_dockerfile -->|"packages"| node_entrypoint
node_package -->|"defines dependencies"| node_entrypoint

classDef toneNeutral fill:#f8fafc,stroke:#334155,stroke-width:1.5px,color:#0f172a
classDef toneBlue fill:#dbeafe,stroke:#2563eb,stroke-width:1.5px,color:#172554
classDef toneAmber fill:#fef3c7,stroke:#d97706,stroke-width:1.5px,color:#78350f
classDef toneMint fill:#dcfce7,stroke:#16a34a,stroke-width:1.5px,color:#14532d
classDef toneRose fill:#ffe4e6,stroke:#e11d48,stroke-width:1.5px,color:#881337
classDef toneIndigo fill:#e0e7ff,stroke:#4f46e5,stroke-width:1.5px,color:#312e81
classDef toneTeal fill:#ccfbf1,stroke:#0f766e,stroke-width:1.5px,color:#134e4a

class node_landing,node_player_page,node_bot_page,node_player_client,node_bot_client,node_board_assets,node_styles toneBlue
class node_express,node_socket_gateway,node_role_assignment,node_move_handler,node_chess_state,node_entrypoint toneAmber
class node_dockerfile,node_ci_build,node_package toneMint
```