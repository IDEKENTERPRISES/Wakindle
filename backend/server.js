const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const VALID_WORDS = ["REACT", "LINUX", "BOARD", "GAMES", "MATCH", "STACK", "PROXY"];

// --- State Store ---
// Structure: { 
//   CODE: { 
//     secretWord: 'GAMES',
//     gameStarted: true,
//     players: {
//       'sockId1': { status: 'playing', guessesCount: 0, fullBoard: [] }, // board stores full guess/color arrays
//       'sockId2': { status: 'won',     guessesCount: 3, fullBoard: [...] },
//     } 
//   } 
// }
const rooms = {};

// --- Helper: Grade Guess ---
function gradeGuess(guess, secretWord) {
    const result = Array(5).fill('gray');
    const secretArr = secretWord.split('');
    const guessArr = guess.split('');

    for (let i = 0; i < 5; i++) {
        if (guessArr[i] === secretArr[i]) {
            result[i] = 'green'; secretArr[i] = null;
        }
    }
    for (let i = 0; i < 5; i++) {
        if (result[i] === 'gray') {
            const matchIndex = secretArr.indexOf(guessArr[i]);
            if (matchIndex !== -1) {
                result[i] = 'yellow'; secretArr[matchIndex] = null;
            }
        }
    }
    return result;
}

// --- WebSocket Logic ---
io.on('connection', (socket) => {
    console.log(`Guest-${socket.id.substring(0, 4)} connected`);

    // 1. Join/Create Room
    socket.on('join_room', (roomCode, playerName) => {
        roomCode = roomCode.toUpperCase();
        playerName = playerName ? playerName.trim() : '';
        if (playerName && playerName.length > 1 && playerName.length < 11) {
            playerName = playerName.substring(0, 10);
        } else {
            playerName = `Guest-${socket.id.substring(0, 4)}`;
        }
        
        if (!rooms[roomCode]) {
            rooms[roomCode] = { secretWord: '', gameStarted: false, players: {}, scores: {} };
        }
        const room = rooms[roomCode];
        const playerIds = Object.keys(room.players);

        if (room.scores[socket.id] === undefined) {
            room.scores[socket.id] = 0;
        }

        if (playerIds.length >= 3) {
            socket.emit('room_error', 'This room is already full!');
            return;
        }
        if (room.gameStarted) {
            socket.emit('room_error', 'Game has already started!');
            return;
        }

        // Assign to room, initializing player object
        socket.join(roomCode);
        room.players[socket.id] = { status: 'playing', guessesCount: 0, fullBoard: [], name: playerName };

        console.log(`${playerName} joined ${roomCode}. (${Object.keys(room.players).length}/3)`);

        // Broadcast updated player LIST (for lobby display)
        io.to(roomCode).emit('room_updated', { roomCode, players: Object.keys(room.players).map(id => ({ id, name: room.players[id].name })) });

        // Handle Game Start (3 players)
        if (Object.keys(room.players).length === 3) {
            room.secretWord = VALID_WORDS[Math.floor(Math.random() * VALID_WORDS.length)];
            room.gameStarted = true;
            console.log(`[${roomCode}] Started. Secret: ${room.secretWord}`);

            // Send player IDs and names to all players in the room
            io.to(roomCode).emit('game_start', { players: Object.keys(room.players).map(id => ({ id, name: room.players[id].name })) });
        }
    });

    // 2. Handle Guesses and End-of-Round
    socket.on('submit_guess', (data) => {
        const { roomCode, guess } = data;
        const room = rooms[roomCode];

        if (!room || !room.gameStarted || !room.players[socket.id]) return;
        const player = room.players[socket.id];

        if (player.status !== 'playing' || player.guessesCount >= 6) return;

        player.guessesCount++;
        const gradedColors = gradeGuess(guess.toUpperCase(), room.secretWord);

        // Save the guess AND the colors to the player's full board history
        const guessData = { guess: guess.toUpperCase(), colors: gradedColors };
        player.fullBoard.push(guessData);

        socket.emit('guess_result', {
            guess: guess.toUpperCase(),
            colors: gradedColors,
            guessesCount: player.guessesCount
        });

        let newStatus = player.status;
        const isCorrect = gradedColors.every(c => c === 'green');

        if (isCorrect) {
            newStatus = 'won';
            room.scores[socket.id] += (7 - player.guessesCount);
        } else if (player.guessesCount >= 6) {
            newStatus = 'lost';
        }

        player.status = newStatus;

        // TARGETED BROADCAST: Send data to other players based on THEIR status
        for (const otherSocketId in room.players) {
            if (otherSocketId === socket.id) continue; // Don't send to self

            const otherPlayer = room.players[otherSocketId];

            // If the receiving player has finished, they are allowed to see the letters
            const canSeeLetters = otherPlayer.status !== 'playing';

            io.to(otherSocketId).emit('opponent_update', {
                playerId: socket.id,
                colors: gradedColors,
                guessesCount: player.guessesCount,
                status: player.status,
                didWin: isCorrect,
                guess: canSeeLetters ? guess.toUpperCase() : null // The secure filter
            });
        }

        // REVEAL HISTORY: If THIS player just finished, reveal all opponent history to them
        if (newStatus !== 'playing') {
            const allOpponentsBoards = {};
            for (const otherSocketId in room.players) {
                if (otherSocketId === socket.id) continue;
                allOpponentsBoards[otherSocketId] = room.players[otherSocketId].fullBoard;
            }
            socket.emit('reveal_boards', allOpponentsBoards);
        }

        const allFinished = Object.values(room.players).every(p => p.status !== 'playing');

        if (allFinished) {
            console.log(`[${roomCode}] Round over. Word was: ${room.secretWord}`);
            room.gameStarted = false;

            io.to(roomCode).emit('match_over', {
                secretWord: room.secretWord,
                scores: room.scores
            });
        }
    });

    // 3. Handle Next Round
    socket.on('next_round', (roomCode) => {
        const room = rooms[roomCode];

        // Prevent triggering if room doesn't exist or game is already actively running
        if (!room || room.gameStarted) return;

        // Reset every player's game board and status (but keep the scores intact!)
        for (const playerId in room.players) {
            room.players[playerId] = {
                status: 'playing',
                guessesCount: 0,
                fullBoard: []
            };
        }

        // Pick a new secret word
        room.secretWord = VALID_WORDS[Math.floor(Math.random() * VALID_WORDS.length)];
        room.gameStarted = true;
        console.log(`[${roomCode}] Next round started. New Secret: ${room.secretWord}`);

        // Tell everyone in the room to reset their UI and start the new round
        io.to(roomCode).emit('game_start', { players: Object.keys(room.players).map(id => ({ id, name: room.players[id].name })) });
    });

    // 4. Disconnect/Cleanup
    socket.on('disconnect', () => {
        console.log(`Socket ${socket.id.substring(0, 4)} disconnected`);

        for (const roomCode in rooms) {
            const room = rooms[roomCode];

            if (room.players[socket.id]) {
                // Grab the name BEFORE deleting the player
                const playerName = room.players[socket.id].name;
                delete room.players[socket.id];

                // Inform remaining players
                io.to(roomCode).emit('room_updated', {
                    roomCode,
                    players: Object.keys(room.players).map(id => ({ id, name: room.players[id].name })),
                    disconnectedPlayerId: socket.id,
                });

                console.log(`${playerName} removed from ${roomCode}. Remaining: ${Object.keys(room.players).length}`);
                if (Object.keys(room.players).length === 0) delete rooms[roomCode];
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Backend Active: Port ${PORT}`));