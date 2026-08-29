import { useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';

const socket: Socket = io({ path: '/socket.io' });

// --- TypeScript Interfaces ---
interface GuessData {
  guess: string;
  colors: string[];
  guessesCount: number;
}

interface OpponentUpdateData {
  playerId: string;
  colors: string[];
  guess: string | null;
  guessesCount: number;
  status: string;
  didWin: boolean;
}

interface OpponentState {
  board: { guess?: string | null; colors: string[] }[];
  guessesCount: number;
  status: string;
}

const KEYBOARD_ROWS = [
  ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
  ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
  ['ENTER', 'Z', 'X', 'C', 'V', 'B', 'N', 'M', '⌫']
];

function App() {
  const [isConnected, setIsConnected] = useState(socket.connected);
  const [roomInput, setRoomInput] = useState('');
  const [currentRoom, setCurrentRoom] = useState<string | null>(null);
  const [players, setPlayers] = useState<{ id: string, name: string }[]>([]);
  const [gameStarted, setGameStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scores, setScores] = useState<Record<string, number>>({});
  const [revealedWord, setRevealedWord] = useState<string | null>(null);

  // Local Player State
  const [currentGuess, setCurrentGuess] = useState('');
  const [myName, setMyName] = useState<string | null>(null);
  const [nameInput, setNameInput] = useState('');
  const [myGuesses, setMyGuesses] = useState<GuessData[]>([]);
  const [playerStatus, setPlayerStatus] = useState<'playing' | 'won' | 'lost'>('playing');

  // Opponents State (Now tracks the board, guess count, and status)
  const [opponents, setOpponents] = useState<Record<string, OpponentState>>({});

  useEffect(() => {
    socket.on('connect', () => setIsConnected(true));
    socket.on('disconnect', () => {
      setIsConnected(false);
      resetGameState();
    });

    socket.on('room_updated', (data: { roomCode: string, players: { id: string, name: string }[] }) => {
      setCurrentRoom(data.roomCode);
      setPlayers(data.players);
      setError(null);
    });

    socket.on('game_start', (data: { players: { id: string, name: string }[] }) => {
      if (data && data.players) {
        setPlayers(data.players);
      }

      setMyGuesses([]);
      setOpponents({});
      setPlayerStatus('playing');
      setRevealedWord(null);
      setGameStarted(true);
    });

    socket.on('room_error', (message: string) => setError(message));
    
    socket.on('guess_error', (message: string) => {
      setError(message);
      // Auto-clear the error message after 2.5 seconds
      setTimeout(() => setError(null), 2500);
    });

    // Handle Local Guess Result
    socket.on('guess_result', (data: GuessData) => {
      setMyGuesses((prev) => [...prev, data]);
      setCurrentGuess('');

      // Check for win/loss to lock the frontend UI
      const isWin = data.colors.every(color => color === 'green');
      if (isWin) {
        setPlayerStatus('won');
      } else if (data.guessesCount >= 6) {
        setPlayerStatus('lost');
      }
    });

    // Handle Opponent Updates
    socket.on('opponent_update', (data: OpponentUpdateData) => {
      setOpponents((prev) => {
        const existing = prev[data.playerId] || { board: [], guessesCount: 0, status: 'playing' };
        return {
          ...prev,
          [data.playerId]: {
            ...existing,
            // Save both the colors and the guess string (which might be null)
            board: [...existing.board, { guess: data.guess, colors: data.colors }],
            guessesCount: data.guessesCount,
            status: data.status
          }
        };
      });
    });

    // NEW: Handle Full Board Reveals when you finish
    socket.on('reveal_boards', (boardsData: Record<string, { guess: string, colors: string[] }[]>) => {
      setOpponents((prev) => {
        const nextState = { ...prev };
        for (const oppId in boardsData) {
          if (!nextState[oppId]) {
            nextState[oppId] = { board: [], guessesCount: 0, status: 'playing' };
          }
          // Overwrite their board history with the fully revealed versions
          nextState[oppId] = { ...nextState[oppId], board: boardsData[oppId] };
        }
        return nextState;
      });
    });

    // Listen for the match over event
    socket.on('match_over', (data: { secretWord: string, scores: Record<string, number> }) => {
      setRevealedWord(data.secretWord);
      setScores(data.scores);
    });

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('room_updated');
      socket.off('game_start');
      socket.off('room_error');
      socket.off('guess_error');
      socket.off('guess_result');
      socket.off('opponent_update');
      socket.off('match_over');
      socket.off('reveal_boards')
    };

  }, []);

  const resetGameState = () => {
    setCurrentRoom(null);
    setGameStarted(false);
    setMyGuesses([]);
    setOpponents({});
    setPlayerStatus('playing');
    setRevealedWord(null);
  };

  const handleJoinRoom = () => {
    let nameToUse = myName;

    if (!nameToUse) {
      nameToUse = "Guest-" + socket.id?.substring(0, 4);
      setMyName(nameToUse);
    }

    if (roomInput.trim()) {
      socket.emit('join_room', roomInput, myName);
    }
  };

  const handleGuessSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (currentGuess.length === 5 && playerStatus === 'playing') {
      socket.emit('submit_guess', { roomCode: currentRoom, guess: currentGuess });
    }
  };

  const handleNextRound = () => {
    if (currentRoom) {
      socket.emit('next_round', currentRoom);
    }
  };

  // Computes the color state for the virtual keyboard
  const getLetterStatuses = () => {
    const statuses: Record<string, string> = {};
    myGuesses.forEach(guessData => {
      guessData.guess.split('').forEach((letter, i) => {
        const color = guessData.colors[i];
        const existing = statuses[letter];
        
        // Priority: Green > Yellow > Gray
        if (color === 'green') {
          statuses[letter] = 'green';
        } else if (color === 'yellow' && existing !== 'green') {
          statuses[letter] = 'yellow';
        } else if (color === 'gray' && existing !== 'green' && existing !== 'yellow') {
          statuses[letter] = 'gray';
        }
      });
    });
    return statuses;
  };

  const handleVirtualKey = (key: string) => {
    if (playerStatus !== 'playing') return;
    
    if (key === 'ENTER') {
      if (currentGuess.length === 5) {
        socket.emit('submit_guess', { roomCode: currentRoom, guess: currentGuess });
      }
    } else if (key === '⌫') {
      setCurrentGuess(prev => prev.slice(0, -1));
    } else if (currentGuess.length < 5) {
      setCurrentGuess(prev => prev + key);
    }
  };

  const renderSquare = (letter: string, color: string, key: string, size = 50) => {
    const bgColor = color === 'green' ? '#538d4e' : color === 'yellow' ? '#b59f3b' : color === 'gray' ? '#3a3a3c' : '#ffffff';
    const textColor = color === 'white' ? '#000000' : '#ffffff';
    const border = color === 'white' ? '2px solid #d3d6da' : '2px solid transparent';
    const fontSize = size >= 50 ? '24px' : '16px';

    return (
      <div
        key={key}
        style={{
          width: `${size}px`, height: `${size}px`, backgroundColor: bgColor, color: textColor,
          display: 'flex', justifyContent: 'center', alignItems: 'center',
          fontSize: fontSize, fontWeight: 'bold', border: border, textTransform: 'uppercase'
        }}
      >
        {letter}
      </div>
    );
  };

  return (
    <div style={{ fontFamily: 'sans-serif', textAlign: 'center', marginTop: '30px' }}>
      <h1>Wakindle</h1>
      <p style={{ fontSize: '12px', color: 'gray' }}>
        Server: {isConnected ? '🟢' : '🔴'} | ID: {socket.id}
      </p>
      <p style={{ fontSize: '12px', color: 'gray' }}>
        Name: {myName || "Guest-" + socket.id?.substring(0, 4)}
      </p>

      {error && <p style={{ color: 'red', fontWeight: 'bold' }}>{error}</p>}

      {!currentRoom && (
        <div style={{ marginTop: '30px' }}>
          <input
            type="text" placeholder="YOUR NAME" value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            maxLength={10}
            style={{ padding: '10px', fontSize: '16px', marginRight: '10px' }}
          />
          <button onClick={() => setMyName(nameInput || "Guest-" + socket.id?.substring(0, 4))} style={{ padding: '10px 20px', fontSize: '16px' }}>
            Set Name
          </button>
        </div>
      )}
      {!currentRoom && (
        <div style={{ marginTop: '30px' }}>
          <input
            type="text" placeholder="ROOM CODE" value={roomInput}
            onChange={(e) => setRoomInput(e.target.value.toUpperCase())} maxLength={6}
            style={{ padding: '10px', fontSize: '16px', marginRight: '10px', textTransform: 'uppercase' }}
          />
          <button onClick={handleJoinRoom} style={{ padding: '10px 20px', fontSize: '16px' }}>Join</button>
        </div>
      )}

      {currentRoom && !gameStarted && (
        <div style={{ marginTop: '30px' }}>
          <h2>Room: {currentRoom}</h2>
          <h3>Waiting for players... ({players.length}/3)</h3>
        </div>
      )}

      {gameStarted && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: '50px', marginTop: '20px' }}>

          {/* Main Player Board */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <h2>Your Board (Score: {scores[socket.id || ''] || 0})</h2>
            <div style={{ display: 'grid', gridTemplateRows: 'repeat(6, 1fr)', gap: '5px', marginBottom: '20px' }}>
              {Array.from({ length: 6 }).map((_, rowIndex) => {
                const isCurrentRow = rowIndex === myGuesses.length && playerStatus === 'playing';
                const isPastRow = rowIndex < myGuesses.length;

                return (
                  <div key={`my-row-${rowIndex}`} style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '5px' }}>
                    {Array.from({ length: 5 }).map((_, colIndex) => {
                      let letter = '';
                      let color = 'white';

                      if (isPastRow) {
                        letter = myGuesses[rowIndex].guess[colIndex];
                        color = myGuesses[rowIndex].colors[colIndex];
                      } else if (isCurrentRow) {
                        letter = currentGuess[colIndex] || '';
                      }

                      return renderSquare(letter, color, `my-${rowIndex}-${colIndex}`);
                    })}
                  </div>
                );
              })}
            </div>

            {/* Conditionally render input OR status message */}
            {playerStatus === 'playing' ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%', maxWidth: '500px' }}>
                
                {/* Keep physical input working for desktop users */}
                <form onSubmit={handleGuessSubmit} style={{ marginBottom: '20px' }}>
                  <input
                    type="text" value={currentGuess}
                    onChange={(e) => setCurrentGuess(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))}
                    maxLength={5} placeholder="Type word..." autoFocus
                    style={{ padding: '10px', fontSize: '18px', width: '200px', textAlign: 'center', letterSpacing: '2px' }}
                  />
                  <button type="submit" disabled={currentGuess.length !== 5} style={{ padding: '10px', fontSize: '16px', marginLeft: '10px' }}>
                    Submit
                  </button>
                </form>

                {/* Virtual Keyboard */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%' }}>
                  {KEYBOARD_ROWS.map((row, rowIndex) => (
                    <div key={`kbd-row-${rowIndex}`} style={{ display: 'flex', justifyContent: 'center', gap: '6px' }}>
                      {row.map(key => {
                        const statuses = getLetterStatuses();
                        const status = statuses[key];
                        
                        // Determine key colors
                        const bgColor = status === 'green' ? '#538d4e' : status === 'yellow' ? '#b59f3b' : status === 'gray' ? '#3a3a3c' : '#d3d6da';
                        const textColor = status ? '#ffffff' : '#000000';
                        const isAction = key === 'ENTER' || key === '⌫';
                        
                        return (
                          <button
                            key={key}
                            onClick={() => handleVirtualKey(key)}
                            style={{
                              padding: isAction ? '12px 10px' : '12px 0',
                              width: isAction ? '65px' : '40px',
                              border: 'none',
                              borderRadius: '4px',
                              backgroundColor: bgColor,
                              color: textColor,
                              fontSize: '14px',
                              fontWeight: 'bold',
                              cursor: 'pointer',
                              userSelect: 'none',
                              touchAction: 'manipulation' // Prevents double-tap zooming on mobile
                            }}
                          >
                            {key}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>

              </div>
            ) : (
              <div style={{ padding: '15px', backgroundColor: playerStatus === 'won' ? '#e6ffe6' : '#ffe6e6', border: `2px solid ${playerStatus === 'won' ? 'green' : 'red'}` }}>
                <h3 style={{ margin: 0, color: playerStatus === 'won' ? 'green' : 'red' }}>
                  {playerStatus === 'won' ? '🎉 You got it!' : '❌ Out of guesses!'}
                </h3>
              </div>
            )}
          </div>

          {/* Opponent Spectator Boards */}
          {players.filter(player => player.id !== socket.id).map((opponent) => {
            // Safely grab the data if they've guessed, or use a blank default if it's a new round
            const data = opponents[opponent.id] || { board: [], guessesCount: 0, status: 'playing' };

            return (
              <div key={opponent.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <h3>Player {opponent.name}</h3>
                <p style={{ margin: '0 0 10px 0', fontWeight: 'bold' }}>
                  Score: {scores[opponent.id] || 0}
                </p>

                <div style={{ display: 'grid', gridTemplateRows: 'repeat(6, 1fr)', gap: '3px', marginBottom: '10px' }}>
                  {Array.from({ length: 6 }).map((_, rowIndex) => (
                    <div key={`opp-${opponent.id}-row-${rowIndex}`} style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '3px' }}>
                      {Array.from({ length: 5 }).map((_, colIndex) => {
                        // Extract the row data for this specific guess
                        const rowData = data.board[rowIndex];
                        const color = rowData ? rowData.colors[colIndex] : 'white';
                        // If the guess text exists, grab the specific letter. Otherwise, empty string.
                        const letter = (rowData && rowData.guess) ? rowData.guess[colIndex] : '';

                        return renderSquare(letter, color, `opp-${opponent.id}-${rowIndex}-${colIndex}`, 30);
                      })}
                    </div>
                  ))}
                </div>

                {/* Opponent Status & Guess Count */}
                <div style={{ fontSize: '18px', fontWeight: 'bold' }}>
                  {data.status === 'playing' ? (
                    <span>{data.guessesCount} / 6</span>
                  ) : data.status === 'won' ? (
                    <span style={{ color: 'green' }}>✓ Won in {data.guessesCount}</span>
                  ) : (
                    <span style={{ color: 'red' }}>✗ Lost</span>
                  )}
                </div>
              </div>
            );
          })}

        </div>
      )}

      {/* Match Over Banner */}
      {revealedWord && (
        <div style={{ marginTop: '40px', padding: '20px', backgroundColor: '#333', color: 'white', borderRadius: '10px' }}>
          <h2>Round Over!</h2>
          <p style={{ fontSize: '24px' }}>The word was: <strong style={{ color: '#538d4e', letterSpacing: '3px' }}>{revealedWord}</strong></p>
          <button
            onClick={handleNextRound}
            style={{
              padding: '12px 24px', fontSize: '18px', cursor: 'pointer',
              backgroundColor: '#538d4e', color: 'white', border: 'none',
              borderRadius: '5px', fontWeight: 'bold'
            }}
          >
            Start Next Round
          </button>
        </div>
      )}

    </div>
  );
}

export default App;